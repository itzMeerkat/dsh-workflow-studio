/**
 * 运行记录持久化、Host 重启恢复与保留数量测试。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { DagEngineConfig, DagEngineProvider } from '../src/engine-provider.ts'
import { TestHosts, runEnded } from './host.ts'
import { workflow } from './graph-fixtures.ts'
import { NodeId, type RunId, type WorkflowId } from '../src/shared/types.ts'
import type {
  NodeExecutionContext, NodeExecutionResult, NodeRecoveryPolicy, WorkflowNodeExecutor,
} from '../src/shared/types.ts'

/** 可观察的节点调用记录。 */
interface Calls {
  source: number
  step: number
  stepNotepads: unknown[]
}

/**
 * 一次 Host 进程的节点行为：`step` 在 `block` 为 true 时保存 notepad 后阻塞，直到被取消。
 */
interface HostBehavior {
  block: boolean
  stepRecovery?: NodeRecoveryPolicy
  registerStep?: boolean
}

function executors(calls: Calls, behavior: HostBehavior, stepStarted: () => void): WorkflowNodeExecutor[] {
  const source: WorkflowNodeExecutor = {
    type: 'source',
    label: 'Source',
    description: 'Produces its configured value',
    outputs: [{ name: 'output', type: 'any' }],
    execute: ({ config }) => {
      calls.source++
      return { outputs: { output: config.value } }
    },
  }
  const step: WorkflowNodeExecutor = {
    type: 'step',
    label: 'Step',
    description: 'Saves a notepad value, then optionally blocks until cancelled',
    inputs: [{ name: 'input', type: 'any' }],
    outputs: [{ name: 'output', type: 'any' }],
    ...(behavior.stepRecovery === undefined ? {} : { recovery: behavior.stepRecovery }),
    async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
      calls.step++
      calls.stepNotepads.push(context.notepad.value)
      await context.notepad.save({ attempt: calls.step, key: context.invocationKey })
      if (behavior.block) {
        stepStarted()
        await new Promise<void>((resolve) => { context.signal.addEventListener('abort', () => { resolve() }) })
        throw new Error('aborted')
      }
      return { outputs: { output: context.inputs.input } }
    },
  }
  const bad: WorkflowNodeExecutor = {
    type: 'bad-output',
    label: 'Bad output',
    description: 'Returns a value JSON cannot hold',
    outputs: [{ name: 'output', type: 'any' }],
    execute: () => ({ outputs: { output: new Date(0) } }),
  }
  return behavior.registerStep === false ? [source, bad] : [source, step, bad]
}

describe('运行持久化与恢复', () => {
  const hosts = new TestHosts()

  afterEach(async () => { await hosts.cleanup() })

  /** 启动一个 Host，并返回 step 首次阻塞时兑现的 promise。 */
  async function host(
    root: string,
    calls: Calls,
    behavior: HostBehavior,
    config?: Partial<DagEngineConfig>,
  ): Promise<{ ctx: Context; engine: DagEngineProvider; stepStarted: Promise<void> }> {
    const started = Promise.withResolvers<void>()
    const { ctx, engine } = await hosts.start(root, executors(calls, behavior, () => { started.resolve() }), config)
    return { ctx, engine, stepStarted: started.promise }
  }

  function freshCalls(): Calls {
    return { source: 0, step: 0, stepNotepads: [] }
  }

  async function saveChain(engine: DagEngineProvider, overrides: { recovery?: NodeRecoveryPolicy } = {}): Promise<WorkflowId> {
    return engine.save(workflow(
      { source: { type: 'source', config: { value: 7 } }, step: { type: 'step', ...overrides } },
      ['source>step'],
      { name: 'chain' },
    ))
  }

  /** 在第一个 Host 中启动运行，等待 step 阻塞后停止 Host，返回运行 ID。 */
  async function interruptedRun(root: string, overrides: { recovery?: NodeRecoveryPolicy } = {}): Promise<RunId> {
    const first = await host(root, freshCalls(), { block: true })
    const run = first.engine.start(await saveChain(first.engine, overrides))
    await first.stepStarted
    await hosts.stop(first.ctx)
    return run.runId
  }

  it('Host 停止不写入结束状态；重启后自动重新调用未完成节点，已完成节点不重复执行', async () => {
    const root = await hosts.root()
    const runId = await interruptedRun(root)

    const calls = freshCalls()
    const second = await host(root, calls, { block: false })
    const done = await runEnded(second.ctx, runId)

    assert.equal(done.status, 'completed')
    assert.equal(calls.source, 0)
    assert.equal(calls.step, 1)
    const step = done.nodes.find(record => record.nodeId === NodeId('step'))
    assert.equal(step?.attempts, 2)
    assert.deepEqual(step?.outputs, { output: 7 })
    assert.deepEqual(calls.stepNotepads, [{ attempt: 1, key: `${runId}/step` }])
  })

  it('节点声明 recovery: hold 时等待人工恢复；工作流节点可覆盖为 rerun', async () => {
    const heldRoot = await hosts.root()
    const heldRun = await interruptedRun(heldRoot)
    const held = await host(heldRoot, freshCalls(), { block: false, stepRecovery: 'hold' })
    assert.equal(held.engine.getRun(heldRun)?.status, 'interrupted')
    assert.match(held.engine.getRun(heldRun)?.error ?? '', /节点 step 需要人工恢复/)

    const overrideRoot = await hosts.root()
    const overrideRun = await interruptedRun(overrideRoot, { recovery: 'rerun' })
    const overridden = await host(overrideRoot, freshCalls(), { block: false, stepRecovery: 'hold' })
    assert.equal((await runEnded(overridden.ctx, overrideRun)).status, 'completed')
  })

  it('只保留配置数量的已结束运行', async () => {
    const root = await hosts.root()
    const { engine } = await host(root, freshCalls(), { block: false }, { retainRuns: 2 })
    const workflowId = await saveChain(engine)
    const runIds: RunId[] = []
    for (let index = 0; index < 3; index++) {
      const run = engine.start(workflowId)
      runIds.push(run.runId)
      await run.result
    }
    const retained = engine.listRuns().map(run => run.runId)
    assert.equal(retained.length, 2)
    assert.ok(retained.every(runId => runIds.includes(runId)))
    assert.equal(runIds.filter(runId => engine.getRun(runId) === undefined).length, 1)
  })

})
