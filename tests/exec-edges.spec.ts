/**
 * 执行边测试：排序约束、跳过沿执行边传递，以及执行边的定义校验。
 */

import { afterEach,describe,it } from 'node:test'
import assert from 'node:assert/strict'
import { TestHosts,runEnded,signalRequested } from './host.ts'
import { workflow } from './graph-fixtures.ts'
import { WorkflowNode,type WorkflowNodePorts } from '../src/node.ts'
import { NodeId } from '../src/shared/types.ts'
import type {
DagWorkflowDefinition,NodeExecutionContext,NodeRunRecord,PortDefinition,WorkflowNodeExecutor,
WorkflowRunRecord,
} from '../src/shared/types.ts'

/** 按调用顺序追加节点 ID 的共享记录，每个用例开始时清空。 */
const calls: string[] = []

/** 无输入无数据依赖的节点，异步让出以便并发执行时交错。 */
class MarkNode extends WorkflowNode<{ output: unknown }> {
  readonly type = 'mark'
  readonly label = 'Mark'
  readonly description = 'Records that it ran'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [],
    outputs: [{ name: 'output', type: 'any' }],
  }

  protected async run({ config }: NodeExecutionContext): Promise<{ output: unknown }> {
    const id = String(config.id)
    calls.push(`${id}:start`)
    await new Promise(resolve => setTimeout(resolve, 5))
    calls.push(`${id}:end`)
    return { output: id }
  }
}

/** 带一个必需输入端口的节点，用于构造合法的数据边。 */
class SinkNode extends WorkflowNode<{ output: unknown }> {
  readonly type = 'sink'
  readonly label = 'Sink'
  readonly description = 'Passes one input through'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [{ name: 'input', type: 'any' }],
    outputs: [{ name: 'output', type: 'any' }],
  }

  protected run({ inputs }: NodeExecutionContext): { output: unknown } {
    return { output: inputs.input }
  }
}

/** 等待一个永不送达的外部结果的节点，用来把一个节点稳定地停在 running。 */
const waiter: WorkflowNodeExecutor = {
  type: 'waiter',
  label: 'Waiter',
  description: 'Waits for an external result that never arrives',
  inputs: [],
  outputs: [{ name: 'output', type: 'any' }],
  execute: async (context) => {
    await context.awaitSignal('go', { kind: 'go' })
    return { outputs: { output: null } }
  },
}

/** 一次 Host 中 `block` 节点的阻塞与放行；重启用例据此制造中断。 */
let blockRelease: (() => void) | undefined

/** 被调用后一直阻塞直到运行取消的节点，用于在分支下游制造中断。 */
const blocker: WorkflowNodeExecutor = {
  type: 'blocker',
  label: 'Blocker',
  description: 'Blocks until the run is cancelled',
  inputs: [],
  outputs: [{ name: 'output', type: 'any' }],
  execute: async ({ signal }) => {
    blockRelease?.()
    await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true }) })
    return { outputs: { output: null } }
  },
}

/** 输出 `config.value` 布尔值的节点，用于驱动 branch。 */
const flag: WorkflowNodeExecutor = {
  type: 'flag',
  label: 'Flag',
  description: 'Outputs its configured boolean',
  inputs: [],
  outputs: [{ name: 'output', type: 'boolean' }],
  execute: ({ config }) => ({ outputs: { output: config.value === true } }),
}

/** 完成但不触发任何执行引脚的节点，使其执行后继被跳过。 */
const decline: WorkflowNodeExecutor = {
  type: 'decline',
  label: 'Decline',
  description: 'Completes without firing its execution pin',
  inputs: [],
  outputs: [{ name: 'output', type: 'any' }],
  execute: () => ({ outputs: { output: null }, next: [] }),
}

const executors = [new MarkNode(), new SinkNode(), decline, flag, blocker, waiter]

/** `mark` 节点把自己的 ID 记进 {@link calls}，因此它的配置就是 ID。 */
function mark(id: string) {
  return { [id]: { type: 'mark', config: { id } } }
}

function statuses(record: WorkflowRunRecord): [string, string][] {
  return record.nodes.map(node => [node.nodeId, node.status])
}

function node(record: WorkflowRunRecord, id: string): NodeRunRecord | undefined {
  return record.nodes.find(item => item.nodeId === NodeId(id))
}

describe('执行边', () => {
  const hosts = new TestHosts()
  afterEach(async () => {
    calls.length = 0
    await hosts.cleanup()
  })

  async function run(definition: DagWorkflowDefinition) {
    const { ctx, engine } = await hosts.start(await hosts.root(), executors)
    const id = await engine.save(definition)
    return runEnded(ctx, engine.start(id).runId)
  }

  it('源节点未触发引脚时目标节点不被调用，跳过沿执行边继续传递', async () => {
    const record = await run(workflow(
      { gate: 'decline', ...mark('middle'), ...mark('last') },
      ['gate.then>middle', 'middle.then>last'],
    ))

    assert.equal(record.status, 'completed')
    assert.deepEqual(statuses(record), [['gate', 'completed'], ['middle', 'skipped'], ['last', 'skipped']])
    assert.deepEqual(calls, [])
    assert.equal(node(record, 'middle')?.attempts, 0)
    assert.equal(node(record, 'middle')?.outputs, undefined)
  })

  it('save 拒绝环、不存在的执行引脚和重复的执行边', async () => {
    const { engine } = await hosts.start(await hosts.root(), executors)
    const nodes = { ...mark('a'), ...mark('b') }
    await assert.rejects(
      engine.save(workflow({ ...mark('a'), b: 'sink' }, ['a>b', 'b.then>a'])),
      /包含环/,
    )
    await assert.rejects(engine.save(workflow(nodes, ['a.nope>b'])), /不存在的执行输出引脚 nope/)
    await assert.rejects(engine.save(workflow(nodes, ['a.then>b', 'a.then>b'])), /重复/)
  })
})

describe('分支、合并与输出完整性', () => {
  const hosts = new TestHosts()
  afterEach(async () => {
    calls.length = 0
    await hosts.cleanup()
  })

  async function host() {
    return hosts.start(await hosts.root(), executors)
  }

  it('节点没有交付声明的输出或触发未声明的引脚时失败', async () => {
    // 每个执行器都违反完成时的一条约定，图都是这一个节点。
    const offenders: readonly [PortDefinition[], WorkflowNodeExecutor['execute'], RegExp][] = [
      [
        [{ name: 'output', type: 'any' }, { name: 'extra', type: 'any' }],
        () => ({ outputs: { output: 1 } }),
        /完成时未产生输出端口 extra；无内容时写 null/,
      ],
      [
        [{ name: 'output', type: 'any' }],
        () => ({ outputs: { output: undefined } }),
        /完成时未产生输出端口 output/,
      ],
      [[], () => ({ outputs: {}, next: ['nope'] }), /触发未声明的执行输出引脚 nope/],
      // 声明了互斥引脚的决策节点省略 next 就触发了两个。
      [[], () => ({ outputs: {} }), /决策节点 o 必须恰好触发一个执行输出引脚，实际触发 2 个/],
    ]
    for (const [outputs, execute, message] of offenders) {
      const offender: WorkflowNodeExecutor = {
        type: 'offender',
        label: 'Offender',
        description: 'Breaks one completion rule',
        inputs: [],
        outputs,
        execOutputs: ['yes', 'no'],
        exclusiveExecOutputs: true,
        execute,
      }
      const { ctx, engine } = await hosts.start(await hosts.root(), [offender])
      const id = await engine.save(workflow({ o: 'offender' }, []))
      const record = await runEnded(ctx, engine.start(id).runId)
      assert.equal(record.status, 'failed')
      assert.match(record.error ?? '', message)
    }
  })

  it('取消运行时已开始的节点先结束，结束的运行没有节点停在 running', async () => {
    const { ctx, engine } = await host()
    const id = await engine.save(workflow({ slow: 'waiter', other: 'waiter' }, []))
    const runId = engine.start(id).runId
    await signalRequested(ctx, 'slow')
    await signalRequested(ctx, 'other')

    engine.cancelRun(runId, '人工取消')
    const record = await runEnded(ctx, runId)

    assert.equal(record.status, 'cancelled')
    // The scheduler waits for the nodes it started, so none is left mid-flight in the final record.
    assert.deepEqual(record.nodes.map(item => item.status), ['cancelled', 'cancelled'])
  })

  it('暂停后不再启动已就绪的节点，恢复后继续', async () => {
    const { ctx, engine } = await host()
    // `after` becomes ready only when `slow` completes, which happens while the run is pausing.
    const id = await engine.save(workflow({ slow: 'waiter', ...mark('after') }, ['slow.then>after']))
    const runId = engine.start(id).runId
    await signalRequested(ctx, 'slow')
    engine.pauseRun(runId)
    await engine.signal(runId, NodeId('slow'), 'go', 'done')

    const paused = await new Promise<void>((resolve) => {
      const dispose = ctx.on('dag/paused', (info) => {
        if (info.runId !== runId) return
        dispose()
        resolve()
      })
    }).then(() => engine.getRun(runId)!)
    assert.equal(paused.status, 'paused')
    assert.equal(node(paused, 'after')?.status, 'pending')
    assert.deepEqual(calls, [])

    engine.resumeRun(runId)
    const record = await runEnded(ctx, runId)
    assert.equal(record.status, 'completed')
    assert.equal(node(record, 'after')?.status, 'completed')
  })
})
