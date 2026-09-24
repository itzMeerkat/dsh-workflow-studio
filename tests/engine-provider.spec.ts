/**
 * DAG 引擎默认实现测试。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { TestHosts } from './host.ts'
import { createFixtureNodes } from './fixture-nodes.ts'
import { workflow } from './graph-fixtures.ts'
import { NodeFailure, WorkflowNode, type WorkflowNodePorts } from '../src/node.ts'
import { WorkflowNodeRegistry } from '../src/registry.ts'
import { DagEngineProvider } from '../src/engine-provider.ts'
import { WorkflowStudioController } from '../src/controller.ts'
import { Config as PluginConfig, apply as applyPlugin, inject as pluginInject } from '../src/index.ts'
import { EdgeId, NodeId, RunId, WorkflowId } from '../src/shared/types.ts'
import type {
  DagWorkflowDefinition, NodeExecutionContext, NodeRunRecord, WorkflowNodeExecutor, WorkflowRunRecord,
} from '../src/shared/types.ts'

class SourceNode extends WorkflowNode {
  readonly type = 'source'
  readonly label = 'Source'
  readonly description = 'Produces its configured value'
  protected readonly ports = { inputs: [], outputs: [{ name: 'output', type: 'any' as const }] }
  protected run({ config }: NodeExecutionContext) { return { output: config.value } }
}

class PassNode extends WorkflowNode {
  readonly type = 'pass'
  readonly label = 'Pass'
  readonly description = 'Passes one input through'
  protected readonly ports = {
    inputs: [{ name: 'input', type: 'any' as const }],
    outputs: [{ name: 'output', type: 'any' as const }],
  }
  // Every declared output carries a value on completion, so an absent optional input becomes null.
  protected run({ inputs }: NodeExecutionContext) { return { output: inputs.input ?? null } }
}

/** Plain executor without the base class: receives no condition port. */
const plain: WorkflowNodeExecutor = {
  type: 'plain',
  label: 'Plain',
  description: 'Plain-object executor that records its context',
  inputs: [{ name: 'input', type: 'any', required: false }],
  outputs: [{ name: 'output', type: 'any' }],
  execute: ({ connected, invocationKey, inputs }) => ({
    status: 'completed',
    outputs: { output: { connected: [...connected], invocationKey, inputs } },
  }),
}

const fail: WorkflowNodeExecutor = {
  type: 'fail',
  label: 'Fail',
  description: 'Returns a deterministic failure',
  inputs: [],
  outputs: [{ name: 'output', type: 'any' }],
  execute: () => ({ status: 'failed', error: 'planned failure' }),
}

const binary: WorkflowNodeExecutor = {
  type: 'binary',
  label: 'Binary',
  description: 'Requires two inputs',
  inputs: [{ name: 'left', type: 'any' }, { name: 'right', type: 'any' }],
  outputs: [{ name: 'output', type: 'any' }],
  execute: ({ inputs }) => ({ status: 'completed', outputs: { output: [inputs.left, inputs.right] } }),
}

/** 等待一个外部结果；结果为 `{ ok: false }` 时节点失败。 */
class WaiterNode extends WorkflowNode<{ output: unknown }> {
  readonly type = 'waiter'
  readonly label = 'Waiter'
  readonly description = 'Waits for an external result'
  protected readonly ports: WorkflowNodePorts = { inputs: [], outputs: [{ name: 'output', type: 'any' }] }

  protected async run(context: NodeExecutionContext): Promise<{ output: unknown }> {
    const result = await context.awaitSignal('go', { kind: 'go' })
    if (typeof result === 'object' && result !== null && 'ok' in result && result.ok === false) {
      throw new NodeFailure('外部结果为拒绝')
    }
    return { output: result }
  }
}

const executors = [
  new SourceNode(), new PassNode(), plain, fail, binary, new WaiterNode(), ...createFixtureNodes(),
]

/** `source > pass` 的两节点定义。 */
function linear(name: string): DagWorkflowDefinition {
  return workflow({ source: { type: 'source', config: { value: 1 } }, pass: 'pass' }, ['source>pass'], { name })
}

describe('DagEngineProvider', () => {
  const hosts = new TestHosts()
  afterEach(async () => { await hosts.cleanup() })

  async function setup(root?: string): Promise<{ ctx: Context; engine: DagEngineProvider; root: string }> {
    root ??= await hosts.root()
    return { ...await hosts.start(root, executors), root }
  }

  /** 一个节点的运行记录。 */
  function record(result: WorkflowRunRecord, id: string): NodeRunRecord | undefined {
    return result.nodes.find(node => node.nodeId === NodeId(id))
  }

  it('核心插件按声明依赖加载，只注册流程控制、边界和代码节点，并随卸载移除服务和工具', async () => {
    const ctx = await hosts.context(await hosts.root())
    const tools = new Map<string, ToolDefinition>()
    await ctx.plugin({
      apply(scope: Context) {
        scope.reflect.provide('tools', {
          register(definition: ToolDefinition) {
            tools.set(definition.name, definition)
            return () => {
              if (tools.get(definition.name) === definition) tools.delete(definition.name)
            }
          },
        } as Context['tools'])
      },
    })
    const ready = Promise.withResolvers<void>()
    ctx.inject(['workflowStudioController'], () => { ready.resolve() })
    const plugin = ctx.plugin({ inject: pluginInject, Config: PluginConfig, apply: applyPlugin }, {} as PluginConfig)
    await plugin
    await ready.promise

    assert.ok(ctx.workflowNodeRegistry instanceof WorkflowNodeRegistry)
    assert.ok(ctx.dagEngine instanceof DagEngineProvider)
    assert.ok(ctx.workflowStudioController instanceof WorkflowStudioController)
    // The engine owns the node types whose behavior is execution semantics, the workflow's own
    // boundary, or code generation; nothing else.
    assert.deepEqual(
      ctx.workflowNodeRegistry.listTypes().map(node => node.type).sort(),
      [
        'branch', 'code-atom', 'code-block', 'code-condition', 'merge', 'subworkflow', 'subworkflow-entry', 'subworkflow-exit',
        'workflow-input', 'workflow-output',
      ],
    )
    assert.deepEqual([...tools.keys()].sort(), ['create_workflow', 'describe_workflow', 'get_workflow_run', 'run_workflow'])

    await plugin.dispose()
    assert.equal(ctx.get('dagEngine'), undefined)
    assert.equal(ctx.get('workflowNodeRegistry'), undefined)
    assert.equal(tools.size, 0)
  })

  it('保存定义时拒绝重复 ID、非法端口和缺失入边', async () => {
    const { engine } = await setup()
    const duplicateNode = linear('duplicate')
    duplicateNode.nodes[1]!.id = NodeId('source')
    await assert.rejects(engine.save(duplicateNode), /节点 ID "source" 重复/)

    const badPort = linear('bad-port')
    badPort.edges[0]!.targetPort = 'missing'
    await assert.rejects(engine.save(badPort), /不存在的输入端口 missing/)

    const missingInput = linear('missing-input')
    missingInput.edges = []
    await assert.rejects(engine.save(missingInput), /输入端口 input 缺少入边/)

    const incompatible = linear('incompatible')
    incompatible.nodes[0]!.outputs = [{ name: 'output', type: 'string' }]
    incompatible.nodes[1]!.inputs = [{ name: 'input', type: 'number' }]
    await assert.rejects(engine.save(incompatible), /端口类型不兼容/)
  })

  it('实例声明的端口替换执行器声明的端口，可选输入没有入边时仍执行', async () => {
    const { engine } = await setup()
    const optional = await engine.save(workflow(
      { pass: { type: 'pass', inputs: [{ name: 'input', type: 'any', required: false }] } },
      [],
      { name: 'optional-input' },
    ))
    const first = await engine.start(optional).result
    assert.equal(first.status, 'completed')

    const narrowed = await engine.save(workflow({
      value: { type: 'source', config: { value: 1 } },
      sink: { type: 'pass', inputs: [{ name: 'input', type: 'number' }] },
    }, ['value>sink'], { name: 'instance-inputs' }))
    const second = await engine.start(narrowed).result
    assert.equal(record(second, 'sink')?.status, 'completed')
  })

  it('定义和运行记录都以独立快照返回，调用方改不到引擎内部状态', async () => {
    const { engine } = await setup()
    const definition = linear('snapshot')
    const id = await engine.save(definition)
    definition.nodes[0]!.config.value = 99

    const first = engine.get(id)
    assert.equal(first?.nodes[0]?.config.value, 1)
    first!.nodes[0]!.config.value = 100
    assert.equal(engine.get(id)?.nodes[0]?.config.value, 1)

    const run = engine.start(id)
    const result = await run.result
    result.nodes[0]!.status = 'failed'

    const firstRead = engine.getRun(run.runId)
    assert.equal(firstRead?.nodes[0]?.status, 'completed')
    firstRead!.nodes[0]!.status = 'failed'
    assert.equal(engine.getRun(run.runId)?.nodes[0]?.status, 'completed')
  })

  it('每个定义写入独立文件并在重启后恢复', async () => {
    const first = await setup()
    const alpha = linear('alpha')
    alpha.nodes[0]!.position = { x: 24, y: 48 }
    const alphaId = await first.engine.save(alpha)
    await first.engine.save(linear('beta'))

    // 记录文件名就是工作流 ID，因此存储目录可直接阅读。
    const directory = join(first.root, 'workflow_studio', 'workflows')
    assert.equal(alphaId, 'alpha')
    assert.deepEqual((await readdir(directory)).sort(), ['alpha.json', 'beta.json'])
    const stored = JSON.parse(await readFile(join(directory, `${alphaId}.json`), 'utf8')) as {
      version: number
      record: DagWorkflowDefinition
    }
    assert.equal(stored.version, 2)
    assert.deepEqual(stored.record.nodes[0]?.position, { x: 24, y: 48 })
    assert.deepEqual(stored.record.edges, alpha.edges)

    await hosts.stop(first.ctx)
    const second = await setup(first.root)

    assert.deepEqual(second.engine.list().map(item => item.name).sort(), ['alpha', 'beta'])
    assert.deepEqual(second.engine.get(alphaId)?.nodes[0]?.position, { x: 24, y: 48 })
  })

  it('工作流 ID 由名称派生，同名保存复用它并替换定义', async () => {
    const { engine } = await setup()
    assert.equal(await engine.save(linear('Daily Report v2')), 'daily-report-v2')
    assert.equal(await engine.save(linear('daily report V2')), 'daily-report-v2-2')
    // 后端只接受 [A-Za-z0-9_-]，所以全非 ASCII 名称只能共用同一个基名。
    assert.equal(await engine.save(linear('数据处理')), 'workflow')
    assert.equal(await engine.save(linear('数据清洗')), 'workflow-2')

    const first = linear('same-name')
    first.description = 'first'
    const second = linear('same-name')
    second.description = 'second'
    // 并发保存也只分配一个 ID，最后写入的定义留下。
    const [firstId, secondId] = await Promise.all([engine.save(first), engine.save(second)])
    assert.equal(firstId, secondId)
    assert.equal(engine.get(firstId)?.description, 'second')

    const replacement = linear('same-name')
    replacement.description = 'third'
    assert.equal(await engine.save(replacement), firstId)
    assert.equal(engine.get(firstId)?.description, 'third')
  })

  it('按 ID 更新同名时保留 ID，改名时换到新名称派生的 ID', async () => {
    const { engine, root } = await setup()
    const first = await engine.save(linear('first'))
    await engine.save(linear('second'))

    assert.equal(await engine.update(first, linear('first')), first)

    const renamedId = await engine.update(first, linear('renamed'))
    assert.equal(renamedId, 'renamed')
    assert.equal(engine.get(first), undefined)
    assert.equal(engine.get(renamedId)?.name, 'renamed')
    assert.deepEqual(
      (await readdir(join(root, 'workflow_studio', 'workflows'))).sort(),
      ['renamed.json', 'second.json'],
    )

    await assert.rejects(engine.update(renamedId, linear('second')), /名称 "second" 已存在/)
    await assert.rejects(engine.update(WorkflowId('missing'), linear('renamed')), /工作流 "missing" 不存在/)
  })

  it('节点失败时工作流失败且后续节点取消', async () => {
    const { engine } = await setup()
    const id = await engine.save(workflow({ fail: 'fail', after: 'pass' }, ['fail>after'], { name: 'failure' }))

    const result = await engine.start(id).result

    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /planned failure/)
    assert.deepEqual(result.nodes.map(node => node.status), ['failed', 'cancelled'])
  })

  it('branch 的 condition 非布尔值时节点和工作流失败', async () => {
    const { engine } = await setup()
    const id = await engine.save(workflow(
      { flag: { type: 'source', config: { value: 1 } }, gate: 'branch' },
      ['flag>gate:condition'],
      { name: 'condition-invalid' },
    ))

    const result = await engine.start(id).result

    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /condition 输入必须为布尔值/)
  })

  it('节点上下文提供已连接的数据端口和稳定调用键', async () => {
    const { engine } = await setup()
    const id = await engine.save(workflow(
      { value: { type: 'source', config: { value: 7 } }, probe: 'plain' },
      ['value>probe', 'value.then>probe'],
      { name: 'plain-context' },
    ))
    const result = await engine.start(id).result
    // The execution edge supplies no input and does not appear among the connected ports.
    assert.deepEqual(record(result, 'probe')?.outputs?.output, {
      connected: ['input'],
      invocationKey: `${result.runId}/probe`,
      inputs: { input: 7 },
    })
  })

  it('被执行边跳过的等待节点不声明请求', { timeout: 1000 }, async () => {
    const { engine } = await setup()
    const id = await engine.save(workflow(
      { flag: { type: 'source', config: { value: false } }, gate: 'branch', confirm: 'waiter' },
      ['flag>gate:condition', 'gate.true>confirm'],
      { name: 'gated-waiter' },
    ))
    const result = await engine.start(id).result
    assert.equal(result.status, 'completed')
    assert.equal(record(result, 'confirm')?.status, 'skipped')
    assert.equal(record(result, 'confirm')?.requests, undefined)
  })

  it('branch 分叉执行流，merge 合并选中分支的数据', async () => {
    const { engine } = await setup()
    const id = await engine.save(workflow({
      'compare-left': { type: 'source', config: { value: 10 } },
      'compare-right': { type: 'source', config: { value: 5 } },
      greater: 'greater',
      gate: 'branch',
      'left-value': { type: 'source', config: { value: 'left' } },
      'right-value': { type: 'source', config: { value: 'right' } },
      left: 'pass',
      right: 'pass',
      merge: 'merge',
    }, [
      'compare-left>greater:left',
      'compare-right>greater:right',
      'greater:result>gate:condition',
      'left-value>left',
      'right-value>right',
      'gate.true>left',
      'gate.false>right',
      'left>merge:input1',
      'right>merge:input2',
      'left.then>merge',
      'right.then>merge',
    ], { name: 'branch-merge' }))

    const result = await engine.start(id).result

    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.equal(record(result, 'left')?.status, 'completed')
    assert.equal(record(result, 'right')?.status, 'skipped')
    // merge is the OR join: one dead inbound execution edge does not skip it.
    assert.deepEqual(record(result, 'merge')?.outputs, { output: 'left' })
  })

  it('可变输入节点拒绝不同类型、过少输入和不同型输出', async () => {
    const { engine } = await setup()
    const base = workflow({
      merge: {
        type: 'merge',
        inputs: [
          { name: 'first', type: 'number', required: false },
          { name: 'second', type: 'string', required: false },
        ],
        outputs: [{ name: 'output', type: 'number' }],
      },
    }, [], { name: 'invalid-merge' })
    await assert.rejects(engine.save(base), /所有输入端口必须使用相同类型/)

    base.nodes[0]!.inputs = [{ name: 'first', type: 'number', required: false }]
    await assert.rejects(engine.save(base), /至少需要 2 个输入端口/)

    base.nodes[0]!.inputs = [
      { name: 'first', type: 'number', required: false },
      { name: 'second', type: 'number', required: false },
    ]
    base.nodes[0]!.outputs = [{ name: 'output', type: 'string' }]
    await assert.rejects(engine.save(base), /输出端口必须与输入端口使用相同类型/)
  })

  it('save 拒绝源可能被跳过而目标仍会执行的数据边', async () => {
    const { engine } = await setup()
    const starved = workflow({
      flag: { type: 'source', config: { value: true } },
      gate: 'branch',
      left: { type: 'source', config: { value: 1 } },
      source: { type: 'source', config: { value: 2 } },
      binary: 'binary',
    }, [
      'flag>gate:condition',
      'gate.true>left',
      'left>binary:left',
      'source>binary:right',
    ], { name: 'starved-input' })
    await assert.rejects(engine.save(starved), /可能被跳过，而目标节点 binary 仍会执行/)

    // Gating the consumer behind the same pin makes the wiring sound.
    starved.edges.push({ ...starved.edges[1]!, id: EdgeId('gate-binary'), target: NodeId('binary') })
    const id = await engine.save(starved)
    const result = await engine.start(id).result
    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.deepEqual(record(result, 'binary')?.outputs, { output: [1, 2] })
  })

  it('等待结果的节点保持 running，取消运行时结束等待', { timeout: 1000 }, async () => {
    const { ctx, engine } = await setup()
    const id = await engine.save(workflow({ approval: 'waiter' }, [], { name: 'cancel-waiter' }))
    const requested = Promise.withResolvers<string>()
    ctx.on('dag/signal-requested', (_info, _node, requestId) => { requested.resolve(requestId) })
    const run = engine.start(id)
    assert.equal(await requested.promise, 'go')
    assert.equal(engine.getRun(run.runId)?.nodes[0]?.status, 'running')
    assert.equal(engine.listRuns()[0]?.pendingRequests, 1)

    engine.cancelRun(run.runId, 'operator cancelled')
    const result = await run.result

    assert.equal(result.status, 'cancelled')
    assert.equal(result.nodes[0]?.status, 'cancelled')
  })

  it('同级的等待节点各自收到结果', { timeout: 1000 }, async () => {
    const { ctx, engine } = await setup()
    const id = await engine.save(workflow(
      { 'approval-a': 'waiter', 'approval-b': 'waiter' },
      [],
      { name: 'parallel-waiters' },
    ))
    const requested: string[] = []
    const both = Promise.withResolvers<void>()
    ctx.on('dag/signal-requested', (_info, node) => {
      requested.push(node.nodeId)
      if (requested.length === 2) both.resolve()
    })
    const run = engine.start(id)
    await both.promise

    await engine.signal(run.runId, NodeId('approval-a'), 'go', { ok: true })
    await engine.signal(run.runId, NodeId('approval-b'), 'go', { ok: false })
    const result = await run.result

    assert.equal(result.status, 'failed')
    assert.deepEqual(result.nodes.map(node => [node.nodeId, node.status, node.error]), [
      ['approval-a', 'completed', undefined],
      ['approval-b', 'failed', '外部结果为拒绝'],
    ])
  })

  it('未知工作流和运行 ID 返回明确结果', async () => {
    const { engine } = await setup()
    assert.throws(() => engine.start(WorkflowId('missing')), /未找到/)
    assert.equal(engine.getRun(RunId('missing')), undefined)
  })
})
