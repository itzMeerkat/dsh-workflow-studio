/**
 * 运行记录持久化、Host 重启恢复、notepad 与保留数量测试。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig,
  inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig,
  inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import { WorkflowNodeRegistry } from '../src/registry.ts'
import { DagEngineProvider, type DagEngineConfig } from '../src/engine-provider.ts'
import { EdgeId, NodeId, type RunId, type WorkflowId } from '../src/types.ts'
import type {
  NodeExecutionContext, NodeExecutionResult, NodeRecoveryPolicy, WorkflowNodeExecutor, WorkflowResult,
} from '../src/types.ts'

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
      return { status: 'completed', outputs: { output: config.value } }
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
        return { status: 'failed', error: 'aborted' }
      }
      return { status: 'completed', outputs: { output: context.inputs.input } }
    },
  }
  const bad: WorkflowNodeExecutor = {
    type: 'bad-output',
    label: 'Bad output',
    description: 'Returns a value JSON cannot hold',
    outputs: [{ name: 'output', type: 'any' }],
    execute: () => ({ status: 'completed', outputs: { output: new Date(0) } }),
  }
  return behavior.registerStep === false ? [source, bad] : [source, step, bad]
}

describe('运行持久化与恢复', () => {
  const contexts: Context[] = []
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
    await Promise.all(roots.splice(0).map(async root => rm(root, { recursive: true, force: true })))
  })

  /** 启动一个 Host：存储、注册表、节点和引擎。 */
  async function host(
    root: string,
    calls: Calls,
    behavior: HostBehavior,
    config?: Partial<DagEngineConfig>,
  ): Promise<{ ctx: Context; engine: DagEngineProvider; stepStarted: Promise<void> }> {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
    await ctx.plugin({
      name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig,
    }, { backend: 'json' })
    await ctx.plugin(WorkflowNodeRegistry)
    const started = Promise.withResolvers<void>()
    for (const executor of executors(calls, behavior, () => { started.resolve() })) {
      ctx.workflowNodeRegistry.register(executor, 'run-persistence-tests')
    }
    if (config === undefined) await ctx.plugin(DagEngineProvider)
    else await ctx.plugin(DagEngineProvider, config)
    const engine = ctx.dagEngine as DagEngineProvider
    await engine.recovered
    return { ctx, engine, stepStarted: started.promise }
  }

  async function newRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-runs-'))
    roots.push(root)
    return root
  }

  function freshCalls(): Calls {
    return { source: 0, step: 0, stepNotepads: [] }
  }

  async function saveChain(engine: DagEngineProvider, overrides: { recovery?: NodeRecoveryPolicy } = {}): Promise<WorkflowId> {
    return engine.save({
      name: 'chain',
      nodes: [
        { id: NodeId('source'), type: 'source', config: { value: 7 } },
        { id: NodeId('step'), type: 'step', config: {}, ...overrides },
      ],
      edges: [{ id: EdgeId('edge'), source: NodeId('source'), target: NodeId('step') }],
    })
  }

  /** 在第一个 Host 中启动运行，等待 step 阻塞后停止 Host，返回运行 ID。 */
  async function interruptedRun(root: string, overrides: { recovery?: NodeRecoveryPolicy } = {}): Promise<RunId> {
    const first = await host(root, freshCalls(), { block: true })
    const run = first.engine.start(await saveChain(first.engine, overrides))
    await first.stepStarted
    await first.ctx.fiber.dispose()
    return run.runId
  }

  function ended(ctx: Context, runId: RunId): Promise<WorkflowResult> {
    const engine = ctx.dagEngine
    return new Promise((resolve) => {
      const dispose = ctx.on('dag/end', (info) => {
        if (info.runId !== runId) return
        dispose()
        queueMicrotask(() => { resolve(engine.getRun(runId)!) })
      })
    })
  }

  it('运行记录独立写入文件，结束后仍可查询和列出', async () => {
    const root = await newRoot()
    const { engine } = await host(root, freshCalls(), { block: false })
    const result = await engine.start(await saveChain(engine)).result
    assert.equal(result.status, 'completed')

    const stored = JSON.parse(await readFile(join(root, 'workflow_studio_runs', 'runs', `${result.runId}.json`), 'utf8')) as {
      record: { status: string; nodes: Array<{ nodeId: string; attempts: number }> }
    }
    assert.equal(stored.record.status, 'completed')
    assert.deepEqual(stored.record.nodes.map(node => [node.nodeId, node.attempts]), [['source', 1], ['step', 1]])
    assert.equal(engine.getRun(result.runId)?.status, 'completed')
    assert.deepEqual(engine.listRuns().map(run => [run.runId, run.name, run.status]), [[result.runId, 'chain', 'completed']])
  })

  it('Host 停止不写入结束状态；重启后自动重新调用未完成节点，已完成节点不重复执行', async () => {
    const root = await newRoot()
    const runId = await interruptedRun(root)

    const calls = freshCalls()
    const second = await host(root, calls, { block: false })
    const done = second.engine.getRun(runId)?.status === 'completed'
      ? second.engine.getRun(runId)!
      : await ended(second.ctx, runId)

    assert.equal(done.status, 'completed')
    assert.equal(calls.source, 0)
    assert.equal(calls.step, 1)
    const step = done.nodeRecords.find(record => record.nodeId === NodeId('step'))
    assert.equal(step?.attempts, 2)
    assert.deepEqual(step?.outputs, { output: 7 })
    assert.deepEqual(calls.stepNotepads, [{ attempt: 1, key: `${runId}/step` }])
  })

  it('autoRestart 关闭时运行进入 interrupted，人工恢复后完成', async () => {
    const root = await newRoot()
    const runId = await interruptedRun(root)

    const second = await host(root, freshCalls(), { block: false }, { autoRestart: false })
    const interrupted = second.engine.getRun(runId)
    assert.equal(interrupted?.status, 'interrupted')
    assert.match(interrupted?.error ?? '', /autoRestart/)
    assert.equal(interrupted?.nodeRecords.find(record => record.nodeId === NodeId('step'))?.status, 'pending')

    const done = ended(second.ctx, runId)
    second.engine.resumeRun(runId)
    assert.equal((await done).status, 'completed')
  })

  it('节点声明 recovery: hold 时等待人工恢复；工作流节点可覆盖为 rerun', async () => {
    const heldRoot = await newRoot()
    const heldRun = await interruptedRun(heldRoot)
    const held = await host(heldRoot, freshCalls(), { block: false, stepRecovery: 'hold' })
    assert.equal(held.engine.getRun(heldRun)?.status, 'interrupted')
    assert.match(held.engine.getRun(heldRun)?.error ?? '', /节点 step 需要人工恢复/)

    const overrideRoot = await newRoot()
    const overrideRun = await interruptedRun(overrideRoot, { recovery: 'rerun' })
    const overridden = await host(overrideRoot, freshCalls(), { block: false, stepRecovery: 'hold' })
    const result = overridden.engine.getRun(overrideRun)?.status === 'completed'
      ? overridden.engine.getRun(overrideRun)!
      : await ended(overridden.ctx, overrideRun)
    assert.equal(result.status, 'completed')
  })

  it('恢复时缺少节点类型则中断，注册后可人工恢复', async () => {
    const root = await newRoot()
    const runId = await interruptedRun(root)

    const second = await host(root, freshCalls(), { block: false, registerStep: false })
    assert.equal(second.engine.getRun(runId)?.status, 'interrupted')
    assert.match(second.engine.getRun(runId)?.error ?? '', /未知节点类型: step/)
    assert.throws(() => { second.engine.resumeRun(runId) }, /未知节点类型: step/)

    const calls = freshCalls()
    const [, step] = executors(calls, { block: false }, () => {})
    second.ctx.workflowNodeRegistry.register(step!, 'late-plugin')
    const done = ended(second.ctx, runId)
    second.engine.resumeRun(runId)
    assert.equal((await done).status, 'completed')
    assert.equal(calls.step, 1)
  })

  it('暂停的运行在重启后保持暂停，恢复后完成', async () => {
    const root = await newRoot()
    const first = await host(root, freshCalls(), { block: false })
    const workflowId = await first.engine.save({
      name: 'paused',
      nodes: [
        { id: NodeId('a'), type: 'source', config: { value: 1 } },
        { id: NodeId('b'), type: 'step', config: {} },
      ],
      edges: [{ id: EdgeId('ab'), source: NodeId('a'), target: NodeId('b') }],
    })
    const paused = new Promise<void>((resolve) => { first.ctx.on('dag/paused', () => { resolve() }) })
    const run = first.engine.start(workflowId)
    first.engine.pauseRun(run.runId)
    await paused
    await first.ctx.fiber.dispose()

    const calls = freshCalls()
    const second = await host(root, calls, { block: false })
    assert.equal(second.engine.getRun(run.runId)?.status, 'paused')
    assert.equal(calls.step, 0)
    const done = ended(second.ctx, run.runId)
    second.engine.resumeRun(run.runId)
    assert.equal((await done).status, 'completed')
  })

  it('取消等待恢复的运行会取消剩余节点并写入结束状态', async () => {
    const root = await newRoot()
    const runId = await interruptedRun(root)
    const second = await host(root, freshCalls(), { block: false }, { autoRestart: false })
    const done = ended(second.ctx, runId)
    second.engine.cancelRun(runId, 'no longer needed')
    const result = await done
    assert.equal(result.status, 'cancelled')
    assert.equal(result.nodeRecords.find(record => record.nodeId === NodeId('step'))?.status, 'cancelled')
    assert.equal(second.engine.listRuns()[0]?.status, 'cancelled')
  })

  it('只保留配置数量的已结束运行', async () => {
    const root = await newRoot()
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

  it('非 JSON 输出使节点失败；notepad 拒绝非 JSON 值', async () => {
    const root = await newRoot()
    const { engine } = await host(root, freshCalls(), { block: false })
    const workflowId = await engine.save({
      name: 'bad-output',
      nodes: [{ id: NodeId('bad'), type: 'bad-output', config: {} }],
      edges: [],
    })
    const result = await engine.start(workflowId).result
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /节点 bad 的输出\.output 不是普通 JSON 对象/)

    const context = {
      notepad: undefined as unknown as NodeExecutionContext['notepad'],
    }
    const probe: WorkflowNodeExecutor = {
      type: 'notepad-probe',
      label: 'Probe',
      description: 'Captures its notepad',
      execute: (ctx) => {
        context.notepad = ctx.notepad
        return { status: 'completed', outputs: {} }
      },
    }
    engine.ctx.workflowNodeRegistry.register(probe, 'run-persistence-tests')
    await engine.start(await engine.save({
      name: 'probe',
      nodes: [{ id: NodeId('probe'), type: 'notepad-probe', config: {} }],
      edges: [],
    })).result
    await assert.rejects(context.notepad.save(undefined as never), /notepad 不是 JSON 值/)
  })
})
