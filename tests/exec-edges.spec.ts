/**
 * 执行边测试：排序约束、跳过沿执行边传递，以及执行边的定义校验。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TestHosts, runEnded, signalRequested } from './host.ts'
import { topologicalSort } from '../src/validation.ts'
import { WorkflowNode, type WorkflowNodePorts } from '../src/node.ts'
import { EdgeId, NodeId } from '../src/shared/types.ts'
import type {
  DagWorkflowDefinition, NodeExecutionContext, NodeRunStatus, WorkflowNodeExecutor,
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
    return { status: 'completed', outputs: { output: null } }
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
    return { status: 'completed', outputs: { output: null } }
  },
}

/** 输出 `config.value` 布尔值的节点，用于驱动 branch。 */
const flag: WorkflowNodeExecutor = {
  type: 'flag',
  label: 'Flag',
  description: 'Outputs its configured boolean',
  inputs: [],
  outputs: [{ name: 'output', type: 'boolean' }],
  execute: ({ config }) => ({ status: 'completed', outputs: { output: config.value === true } }),
}

/** 完成但不触发任何执行引脚的节点，使其执行后继被跳过。 */
const decline: WorkflowNodeExecutor = {
  type: 'decline',
  label: 'Decline',
  description: 'Completes without firing its execution pin',
  inputs: [],
  outputs: [{ name: 'output', type: 'any' }],
  execute: () => ({ status: 'completed', outputs: { output: null }, next: [] }),
}

const executors = [new MarkNode(), new SinkNode(), decline, flag, blocker, waiter]

function sink(id: string) {
  return { id: NodeId(id), type: 'sink', config: {} }
}

function mark(id: string) {
  return { id: NodeId(id), type: 'mark', config: { id } }
}

function statuses(nodes: readonly { nodeId: string; status: NodeRunStatus }[]): [string, NodeRunStatus][] {
  return nodes.map(node => [node.nodeId, node.status])
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
    const started = engine.start(id)
    return runEnded(ctx, started.runId)
  }

  it('没有数据依赖的两个节点按执行边顺序执行', async () => {
    const record = await run({
      name: 'ordered',
      nodes: [mark('first'), mark('second')],
      edges: [{ id: EdgeId('order'), kind: 'exec', source: NodeId('first'), target: NodeId('second') }],
    })

    assert.equal(record.status, 'completed')
    assert.deepEqual(calls, ['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('执行边把同层节点拆到相邻层级，没有执行边时它们同层', () => {
    const nodes = [mark('first'), mark('second')]
    assert.deepEqual(
      topologicalSort({ name: 'concurrent', nodes, edges: [] })
        .map(level => level.map(node => node.id)),
      [['first', 'second']],
    )
    assert.deepEqual(
      topologicalSort({
        name: 'ordered',
        nodes,
        edges: [{ id: EdgeId('order'), kind: 'exec', source: NodeId('first'), target: NodeId('second') }],
      }).map(level => level.map(node => node.id)),
      [['first'], ['second']],
    )
  })

  it('源节点未触发引脚时目标节点不被调用，跳过沿执行边继续传递', async () => {
    const record = await run({
      name: 'skip-propagates',
      nodes: [
        { id: NodeId('gate'), type: 'decline', config: {} },
        mark('middle'),
        mark('last'),
      ],
      edges: [
        { id: EdgeId('gate-middle'), kind: 'exec', source: NodeId('gate'), target: NodeId('middle') },
        { id: EdgeId('middle-last'), kind: 'exec', source: NodeId('middle'), target: NodeId('last') },
      ],
    })

    assert.equal(record.status, 'completed')
    assert.deepEqual(statuses(record.nodes), [
      ['gate', 'completed'],
      ['middle', 'skipped'],
      ['last', 'skipped'],
    ])
    assert.deepEqual(calls, [])
    assert.equal(record.nodes.find(node => node.nodeId === 'middle')?.attempts, 0)
    assert.equal(record.nodes.find(node => node.nodeId === 'middle')?.outputs, undefined)
  })

  it('执行边不进入下游节点的输入，也不占用其输入端口', async () => {
    const record = await run({
      name: 'exec-carries-no-data',
      nodes: [mark('first'), mark('second')],
      edges: [{ id: EdgeId('order'), kind: 'exec', source: NodeId('first'), target: NodeId('second') }],
    })

    assert.equal(record.status, 'completed')
    assert.deepEqual(record.nodes.find(node => node.nodeId === 'second')?.inputs, {})
  })

  it('执行边与数据边共同决定拓扑顺序，构成环时被拒绝', async () => {
    const { engine } = await hosts.start(await hosts.root(), executors)
    await assert.rejects(engine.save({
      name: 'mixed-cycle',
      nodes: [mark('a'), sink('b')],
      edges: [
        { id: EdgeId('data'), kind: 'data', source: NodeId('a'), target: NodeId('b') },
        { id: EdgeId('exec'), kind: 'exec', source: NodeId('b'), target: NodeId('a') },
      ],
    }), /包含环/)
  })

  it('save 拒绝不存在的执行引脚和重复的执行边', async () => {
    const { engine } = await hosts.start(await hosts.root(), executors)
    await assert.rejects(engine.save({
      name: 'bad-pin',
      nodes: [mark('a'), mark('b')],
      edges: [{
        id: EdgeId('e'),
        kind: 'exec',
        source: NodeId('a'),
        sourcePort: 'nope',
        target: NodeId('b'),
      }],
    }), /不存在的执行输出引脚 nope/)

    await assert.rejects(engine.save({
      name: 'duplicate-exec',
      nodes: [mark('a'), mark('b')],
      edges: [
        { id: EdgeId('e1'), kind: 'exec', source: NodeId('a'), target: NodeId('b') },
        { id: EdgeId('e2'), kind: 'exec', source: NodeId('a'), target: NodeId('b') },
      ],
    }), /重复/)
  })

  it('同一个输入端口仍只接受一条数据边，而执行输入接受多条执行边', async () => {
    const { engine } = await hosts.start(await hosts.root(), executors)
    await assert.rejects(engine.save({
      name: 'two-data-edges',
      nodes: [mark('a'), mark('b'), sink('c')],
      edges: [
        { id: EdgeId('e1'), kind: 'data', source: NodeId('a'), target: NodeId('c') },
        { id: EdgeId('e2'), kind: 'data', source: NodeId('b'), target: NodeId('c') },
      ],
    }), /存在多条入边/)

    const record = await run({
      name: 'two-exec-edges',
      nodes: [mark('a'), mark('b'), mark('c')],
      edges: [
        { id: EdgeId('e1'), kind: 'exec', source: NodeId('a'), target: NodeId('c') },
        { id: EdgeId('e2'), kind: 'exec', source: NodeId('b'), target: NodeId('c') },
      ],
    })
    assert.equal(record.status, 'completed')
    assert.equal(calls.at(-1), 'c:end')
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

  it('完成时缺少已声明的输出端口使节点失败', async () => {
    const forgetful: WorkflowNodeExecutor = {
      type: 'forgetful',
      label: 'Forgetful',
      description: 'Completes without producing its declared output',
      inputs: [],
      outputs: [{ name: 'output', type: 'any' }, { name: 'extra', type: 'any' }],
      execute: () => ({ status: 'completed', outputs: { output: 1 } }),
    }
    const { ctx, engine } = await hosts.start(await hosts.root(), [...executors, forgetful])
    const id = await engine.save({
      name: 'forgetful',
      nodes: [{ id: NodeId('f'), type: 'forgetful', config: {} }],
      edges: [],
    })
    const record = await runEnded(ctx, engine.start(id).runId)
    assert.equal(record.status, 'failed')
    assert.match(record.error ?? '', /完成时未产生输出端口 extra；无内容时写 null/)
  })

  it('输出端口的值为 undefined 时失败而不是被丢弃', async () => {
    const vanishing: WorkflowNodeExecutor = {
      type: 'vanishing',
      label: 'Vanishing',
      description: 'Sets its declared output to undefined',
      inputs: [],
      outputs: [{ name: 'output', type: 'any' }],
      execute: () => ({ status: 'completed', outputs: { output: undefined } }),
    }
    const { ctx, engine } = await hosts.start(await hosts.root(), [...executors, vanishing])
    const id = await engine.save({
      name: 'vanishing',
      nodes: [{ id: NodeId('v'), type: 'vanishing', config: {} }],
      edges: [],
    })
    const record = await runEnded(ctx, engine.start(id).runId)
    assert.equal(record.status, 'failed')
    assert.match(record.error ?? '', /完成时未产生输出端口 output/)
  })

  it('触发未声明的执行引脚使节点失败', async () => {
    const stray: WorkflowNodeExecutor = {
      type: 'stray',
      label: 'Stray',
      description: 'Fires a pin it never declared',
      inputs: [],
      outputs: [],
      execute: () => ({ status: 'completed', outputs: {}, next: ['nope'] }),
    }
    const { ctx, engine } = await hosts.start(await hosts.root(), [...executors, stray])
    const id = await engine.save({
      name: 'stray',
      nodes: [{ id: NodeId('s'), type: 'stray', config: {} }],
      edges: [],
    })
    const record = await runEnded(ctx, engine.start(id).runId)
    assert.equal(record.status, 'failed')
    assert.match(record.error ?? '', /触发未声明的执行输出引脚 nope/)
  })

  it('merge 在两条入执行边全部失效时才被跳过', async () => {
    const { ctx, engine } = await host()
    const id = await engine.save({
      name: 'merge-all-dead',
      nodes: [
        { id: NodeId('a'), type: 'decline', config: {} },
        { id: NodeId('b'), type: 'decline', config: {} },
        { id: NodeId('m'), type: 'merge', config: {} },
      ],
      edges: [
        { id: EdgeId('am'), kind: 'exec', source: NodeId('a'), target: NodeId('m') },
        { id: EdgeId('bm'), kind: 'exec', source: NodeId('b'), target: NodeId('m') },
      ],
    })
    const record = await runEnded(ctx, engine.start(id).runId)
    assert.equal(record.status, 'completed')
    assert.equal(record.nodes.find(node => node.nodeId === 'm')?.status, 'skipped')
  })

  it('运行摘要报告被跳过的节点数量', async () => {
    const { ctx, engine } = await host()
    const id = await engine.save({
      name: 'skipped-count',
      nodes: [
        { id: NodeId('gate'), type: 'decline', config: {} },
        mark('after'),
      ],
      edges: [{ id: EdgeId('e'), kind: 'exec', source: NodeId('gate'), target: NodeId('after') }],
    })
    const runId = engine.start(id).runId
    await runEnded(ctx, runId)
    assert.equal(engine.listRuns().find(run => run.runId === runId)?.skippedNodes, 1)
  })

  it('普通节点触发唯一的 then 引脚并写入运行记录', async () => {
    const { ctx, engine } = await host()
    const id = await engine.save({
      name: 'fired',
      nodes: [mark('only')],
      edges: [],
    })
    const record = await runEnded(ctx, engine.start(id).runId)
    assert.deepEqual(record.nodes[0]?.fired, ['then'])
  })

  it('分支两条路径各自只触发一个引脚，未触发的一侧被跳过', async () => {
    const { ctx, engine } = await host()
    const flow = (condition: boolean) => ({
      name: `branch-${String(condition)}`,
      nodes: [
        { id: NodeId('flag'), type: 'flag', config: { value: condition } },
        { id: NodeId('gate'), type: 'branch', config: {} },
        mark('yes'),
        mark('no'),
      ],
      edges: [
        { id: EdgeId('f'), kind: 'data' as const, source: NodeId('flag'), target: NodeId('gate'), targetPort: 'condition' },
        { id: EdgeId('y'), kind: 'exec' as const, source: NodeId('gate'), sourcePort: 'true', target: NodeId('yes') },
        { id: EdgeId('n'), kind: 'exec' as const, source: NodeId('gate'), sourcePort: 'false', target: NodeId('no') },
      ],
    })

    const taken = await runEnded(ctx, engine.start(await engine.save(flow(true))).runId)
    assert.equal(taken.status, 'completed')
    assert.deepEqual(statuses(taken.nodes).slice(2), [['yes', 'completed'], ['no', 'skipped']])

    const other = await runEnded(ctx, engine.start(await engine.save(flow(false))).runId)
    assert.equal(other.status, 'completed')
    assert.deepEqual(statuses(other.nodes).slice(2), [['yes', 'skipped'], ['no', 'completed']])
  })

  it('重启后按记录中的 fired 门控下游，不重新调用已完成的分支节点', async () => {
    const root = await hosts.root()
    const started = Promise.withResolvers<void>()
    blockRelease = started.resolve
    const first = await hosts.start(root, executors)
    const definition = {
      name: 'branch-restart',
      nodes: [
        { id: NodeId('flag'), type: 'flag', config: { value: false } },
        { id: NodeId('gate'), type: 'branch', config: {} },
        { id: NodeId('hold'), type: 'blocker', config: {} },
        mark('yes'),
      ],
      edges: [
        { id: EdgeId('f'), kind: 'data' as const, source: NodeId('flag'), target: NodeId('gate'), targetPort: 'condition' },
        { id: EdgeId('h'), kind: 'exec' as const, source: NodeId('gate'), sourcePort: 'false', target: NodeId('hold') },
        { id: EdgeId('y'), kind: 'exec' as const, source: NodeId('gate'), sourcePort: 'true', target: NodeId('yes') },
      ],
    }
    const runId = first.engine.start(await first.engine.save(definition)).runId
    await started.promise
    // The branch completed and was checkpointed; `hold` is still running when the Host stops.
    assert.deepEqual(first.engine.getRun(runId)?.nodes.find(node => node.nodeId === 'gate')?.fired, ['false'])
    await first.ctx.fiber.dispose()

    blockRelease = undefined
    const second = await hosts.start(root, [new MarkNode(), new SinkNode(), decline, flag, {
      ...blocker,
      execute: () => ({ status: 'completed' as const, outputs: { output: 'resumed' } }),
    }])
    const record = await runEnded(second.ctx, runId)

    assert.equal(record.status, 'completed')
    const gate = record.nodes.find(node => node.nodeId === 'gate')
    // The branch node is never called again, so its recorded pin is what gates the run.
    assert.equal(gate?.attempts, 1)
    assert.deepEqual(gate?.fired, ['false'])
    assert.equal(record.nodes.find(node => node.nodeId === 'hold')?.status, 'completed')
    assert.equal(record.nodes.find(node => node.nodeId === 'yes')?.status, 'skipped')
    assert.deepEqual(calls, [])
  })

  it('与长节点无关的链路不等待它，逐个节点就绪即执行', async () => {
    const { ctx, engine } = await host()
    const id = await engine.save({
      name: 'ready-queue',
      nodes: [
        { id: NodeId('slow'), type: 'waiter', config: {} },
        mark('f0'),
        mark('f1'),
        mark('f2'),
      ],
      edges: [
        { id: EdgeId('a'), kind: 'exec', source: NodeId('f0'), target: NodeId('f1') },
        { id: EdgeId('b'), kind: 'exec', source: NodeId('f1'), target: NodeId('f2') },
      ],
    })

    const runId = engine.start(id).runId
    const chainDone = new Promise<void>((resolve) => {
      const dispose = ctx.on('dag/node-end', (info, node) => {
        if (info.runId !== runId || node.nodeId !== 'f2') return
        dispose()
        resolve()
      })
    })
    await chainDone

    // Under a level barrier f1 and f2 sit in later levels and could not finish while `slow` runs.
    const record = engine.getRun(runId)!
    assert.equal(record.nodes.find(item => item.nodeId === 'slow')?.status, 'running')
    assert.deepEqual(
      record.nodes.filter(item => item.nodeId.startsWith('f')).map(item => item.status),
      ['completed', 'completed', 'completed'],
    )
    engine.cancelRun(runId, 'done')
    await runEnded(ctx, runId)
  })

  it('取消运行时已开始的节点先结束，结束的运行没有节点停在 running', async () => {
    const { ctx, engine } = await host()
    const id = await engine.save({
      name: 'cancel-drains',
      nodes: [
        { id: NodeId('slow'), type: 'waiter', config: {} },
        { id: NodeId('other'), type: 'waiter', config: {} },
      ],
      edges: [],
    })
    const runId = engine.start(id).runId
    await signalRequested(ctx, 'slow')
    await signalRequested(ctx, 'other')

    engine.cancelRun(runId, '人工取消')
    const record = await runEnded(ctx, runId)

    assert.equal(record.status, 'cancelled')
    // The scheduler waits for the nodes it started, so none is left mid-flight in the final record.
    assert.deepEqual(record.nodes.map(node => node.status), ['cancelled', 'cancelled'])
  })

  it('暂停后不再启动已就绪的节点，恢复后继续', async () => {
    const { ctx, engine } = await host()
    const id = await engine.save({
      name: 'pause-holds',
      nodes: [
        { id: NodeId('slow'), type: 'waiter', config: {} },
        mark('after'),
      ],
      // `after` becomes ready only when `slow` completes, which happens while the run is pausing.
      edges: [{ id: EdgeId('o'), kind: 'exec', source: NodeId('slow'), target: NodeId('after') }],
    })
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
    assert.equal(paused.nodes.find(node => node.nodeId === 'after')?.status, 'pending')
    assert.deepEqual(calls, [])

    engine.resumeRun(runId)
    const record = await runEnded(ctx, runId)
    assert.equal(record.status, 'completed')
    assert.equal(record.nodes.find(node => node.nodeId === 'after')?.status, 'completed')
  })
})
