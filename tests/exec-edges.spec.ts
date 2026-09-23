/**
 * 执行边测试：排序约束、跳过沿执行边传递，以及执行边的定义校验。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TestHosts, runEnded, signalRequested } from './host.ts'
import { workflow } from './graph-fixtures.ts'
import { topologicalSort } from '../src/validation.ts'
import { WorkflowNode, type WorkflowNodePorts } from '../src/node.ts'
import { NodeId } from '../src/shared/types.ts'
import type {
  DagWorkflowDefinition, NodeExecutionContext, NodeRunRecord, PortDefinition, WorkflowNodeExecutor,
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

  it('执行边决定顺序，但不进入下游节点的输入', async () => {
    const record = await run(workflow({ ...mark('first'), ...mark('second') }, ['first.then>second']))

    assert.equal(record.status, 'completed')
    assert.deepEqual(calls, ['first:start', 'first:end', 'second:start', 'second:end'])
    assert.deepEqual(node(record, 'second')?.inputs, {})
  })

  it('执行边把同层节点拆到相邻层级，没有执行边时它们同层', () => {
    const levels = (definition: DagWorkflowDefinition) =>
      topologicalSort(definition).map(level => level.map(item => item.id))
    const nodes = { ...mark('first'), ...mark('second') }
    assert.deepEqual(levels(workflow(nodes, [])), [['first', 'second']])
    assert.deepEqual(levels(workflow(nodes, ['first.then>second'])), [['first'], ['second']])
  })

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

  it('同一个输入端口仍只接受一条数据边，而执行输入接受多条执行边', async () => {
    const { engine } = await hosts.start(await hosts.root(), executors)
    await assert.rejects(
      engine.save(workflow({ ...mark('a'), ...mark('b'), c: 'sink' }, ['a>c', 'b>c'])),
      /存在多条入边/,
    )

    const record = await run(workflow(
      { ...mark('a'), ...mark('b'), ...mark('c') },
      ['a.then>c', 'b.then>c'],
    ))
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

  it('节点没有交付声明的输出或触发未声明的引脚时失败', async () => {
    // 每个执行器都违反完成时的一条约定，图都是这一个节点。
    const offenders: readonly [PortDefinition[], WorkflowNodeExecutor['execute'], RegExp][] = [
      [
        [{ name: 'output', type: 'any' }, { name: 'extra', type: 'any' }],
        () => ({ status: 'completed', outputs: { output: 1 } }),
        /完成时未产生输出端口 extra；无内容时写 null/,
      ],
      [
        [{ name: 'output', type: 'any' }],
        () => ({ status: 'completed', outputs: { output: undefined } }),
        /完成时未产生输出端口 output/,
      ],
      [[], () => ({ status: 'completed', outputs: {}, next: ['nope'] }), /触发未声明的执行输出引脚 nope/],
    ]
    for (const [outputs, execute, message] of offenders) {
      const offender: WorkflowNodeExecutor = {
        type: 'offender', label: 'Offender', description: 'Breaks one completion rule', inputs: [], outputs, execute,
      }
      const { ctx, engine } = await hosts.start(await hosts.root(), [offender])
      const id = await engine.save(workflow({ o: 'offender' }, []))
      const record = await runEnded(ctx, engine.start(id).runId)
      assert.equal(record.status, 'failed')
      assert.match(record.error ?? '', message)
    }
  })

  it('merge 在两条入执行边全部失效时才被跳过', async () => {
    const { ctx, engine } = await host()
    const id = await engine.save(workflow(
      { a: 'decline', b: 'decline', m: 'merge' },
      ['a.then>m', 'b.then>m'],
    ))
    const record = await runEnded(ctx, engine.start(id).runId)
    assert.equal(record.status, 'completed')
    assert.equal(node(record, 'm')?.status, 'skipped')
  })

  it('普通节点触发唯一的 then 引脚，被跳过的节点计入运行摘要', async () => {
    const { ctx, engine } = await host()
    const id = await engine.save(workflow(
      { ...mark('plain'), gate: 'decline', ...mark('after') },
      ['plain.then>gate', 'gate.then>after'],
    ))
    const runId = engine.start(id).runId
    const record = await runEnded(ctx, runId)
    assert.deepEqual(node(record, 'plain')?.fired, ['then'])
    assert.equal(engine.listRuns().find(item => item.runId === runId)?.skippedNodes, 1)
  })

  it('分支两条路径各自只触发一个引脚，未触发的一侧被跳过', async () => {
    const { ctx, engine } = await host()
    const flow = (condition: boolean) => workflow(
      { flag: { type: 'flag', config: { value: condition } }, gate: 'branch', ...mark('yes'), ...mark('no') },
      ['flag>gate:condition', 'gate.true>yes', 'gate.false>no'],
      { name: `branch-${String(condition)}` },
    )

    const taken = await runEnded(ctx, engine.start(await engine.save(flow(true))).runId)
    assert.equal(taken.status, 'completed')
    assert.deepEqual(statuses(taken).slice(2), [['yes', 'completed'], ['no', 'skipped']])

    const other = await runEnded(ctx, engine.start(await engine.save(flow(false))).runId)
    assert.equal(other.status, 'completed')
    assert.deepEqual(statuses(other).slice(2), [['yes', 'skipped'], ['no', 'completed']])
  })

  it('重启后按记录中的 fired 门控下游，不重新调用已完成的分支节点', async () => {
    const root = await hosts.root()
    const started = Promise.withResolvers<void>()
    blockRelease = started.resolve
    const first = await hosts.start(root, executors)
    const definition = workflow({
      flag: { type: 'flag', config: { value: false } },
      gate: 'branch',
      hold: 'blocker',
      ...mark('yes'),
    }, ['flag>gate:condition', 'gate.false>hold', 'gate.true>yes'], { name: 'branch-restart' })
    const runId = first.engine.start(await first.engine.save(definition)).runId
    await started.promise
    // The branch completed and was checkpointed; `hold` is still running when the Host stops.
    assert.deepEqual(node(first.engine.getRun(runId)!, 'gate')?.fired, ['false'])
    await hosts.stop(first.ctx)

    blockRelease = undefined
    const second = await hosts.start(root, [new MarkNode(), new SinkNode(), decline, flag, {
      ...blocker,
      execute: () => ({ status: 'completed' as const, outputs: { output: 'resumed' } }),
    }])
    const record = await runEnded(second.ctx, runId)

    assert.equal(record.status, 'completed')
    // The branch node is never called again, so its recorded pin is what gates the run.
    assert.equal(node(record, 'gate')?.attempts, 1)
    assert.deepEqual(node(record, 'gate')?.fired, ['false'])
    assert.equal(node(record, 'hold')?.status, 'completed')
    assert.equal(node(record, 'yes')?.status, 'skipped')
    assert.deepEqual(calls, [])
  })

  it('与长节点无关的链路不等待它，逐个节点就绪即执行', async () => {
    const { ctx, engine } = await host()
    const id = await engine.save(workflow(
      { slow: 'waiter', ...mark('f0'), ...mark('f1'), ...mark('f2') },
      ['f0.then>f1', 'f1.then>f2'],
    ))

    const runId = engine.start(id).runId
    await new Promise<void>((resolve) => {
      const dispose = ctx.on('dag/node-end', (info, item) => {
        if (info.runId !== runId || item.nodeId !== 'f2') return
        dispose()
        resolve()
      })
    })

    // Under a level barrier f1 and f2 sit in later levels and could not finish while `slow` runs.
    const record = engine.getRun(runId)!
    assert.equal(node(record, 'slow')?.status, 'running')
    assert.deepEqual(
      record.nodes.filter(item => item.nodeId.startsWith('f')).map(item => item.status),
      ['completed', 'completed', 'completed'],
    )
    engine.cancelRun(runId, 'done')
    await runEnded(ctx, runId)
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
