/**
 * DAG 引擎默认实现测试。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig,
  inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig,
  inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import { registerFixtureNodes } from './fixture-nodes.ts'
import { NodeFailure, WorkflowNode, type WorkflowNodePorts } from '../src/node.ts'
import { WorkflowNodeRegistry } from '../src/registry.ts'
import { DagEngineProvider } from '../src/engine-provider.ts'
import { WorkflowStudioController } from '../src/controller.ts'
import { Config as PluginConfig, apply as applyPlugin, inject as pluginInject } from '../src/index.ts'
import { EdgeId, NodeId, RunId, WorkflowId } from '../src/shared/types.ts'
import type { DagWorkflowDefinition, NodeExecutionContext, WorkflowNodeExecutor } from '../src/shared/types.ts'

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

const source = new SourceNode()
const pass = new PassNode()

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

/** Executor that completes without firing any execution pin, so its successors are skipped. */
const decline: WorkflowNodeExecutor = {
  type: 'decline',
  label: 'Decline',
  description: 'Completes without firing its execution pin',
  inputs: [],
  outputs: [{ name: 'output', type: 'any' }],
  execute: () => ({ status: 'completed', outputs: { output: null }, next: [] }),
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
  inputs: [
    { name: 'left', type: 'any' },
    { name: 'right', type: 'any' },
  ],
  outputs: [{ name: 'output', type: 'any' }],
  execute: ({ inputs }) => ({
    status: 'completed',
    outputs: { output: [inputs.left, inputs.right] },
  }),
}

/** 等待一个外部结果；结果为 `{ ok: false }` 时节点失败。 */
class WaiterNode extends WorkflowNode<{ output: unknown }> {
  readonly type = 'waiter'
  readonly label = 'Waiter'
  readonly description = 'Waits for an external result'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [],
    outputs: [{ name: 'output', type: 'any' }],
  }

  protected async run(context: NodeExecutionContext): Promise<{ output: unknown }> {
    const result = await context.awaitSignal('go', { kind: 'go' })
    if (typeof result === 'object' && result !== null && 'ok' in result && result.ok === false) {
      throw new NodeFailure('外部结果为拒绝')
    }
    return { output: result }
  }
}

const executors = [source, pass, plain, decline, fail, binary, new WaiterNode()]

function linearWorkflow(name: string): DagWorkflowDefinition {
  return {
    name,
    nodes: [
      { id: NodeId('source'), type: 'source', config: { value: 1 } },
      { id: NodeId('pass'), type: 'pass', config: {} },
    ],
    edges: [
      { id: EdgeId('edge'), kind: 'data', source: NodeId('source'), target: NodeId('pass') },
    ],
  }
}

describe('DagEngineProvider', () => {
  const contexts: Context[] = []
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
    await Promise.all(roots.splice(0).map(async root => rm(root, { recursive: true, force: true })))
  })

  async function setup(root?: string): Promise<{ ctx: Context; engine: DagEngineProvider; root: string }> {
    root ??= await mkdtemp(join(tmpdir(), 'dsh-workflow-studio-'))
    if (!roots.includes(root)) roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin({
      name: storageJsonName,
      inject: storageJsonInject,
      apply: storageJsonApply,
      Config: storageJsonConfig,
    }, { root })
    await ctx.plugin({
      name: storageDomainName,
      inject: storageDomainInject,
      apply: storageDomainApply,
      Config: storageDomainConfig,
    }, { backend: 'json' })
    await ctx.plugin(WorkflowNodeRegistry)
    registerFixtureNodes(ctx)
    for (const executor of executors) {
      ctx.workflowNodeRegistry.register(executor, 'engine-provider-tests')
    }
    await ctx.plugin(DagEngineProvider)
    return { ctx, engine: ctx.dagEngine as DagEngineProvider, root }
  }

  it('Cordis 按声明依赖等待节点注册表后加载引擎', async () => {
    const { ctx } = await setup()
    assert.ok(ctx.workflowNodeRegistry instanceof WorkflowNodeRegistry)
    assert.ok(ctx.dagEngine instanceof DagEngineProvider)
  })

  it('核心插件只注册流程控制节点，并随卸载移除服务和工具', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-studio-'))
    roots.push(root)
    await ctx.plugin(Storage)
    await ctx.plugin({
      name: storageJsonName,
      inject: storageJsonInject,
      apply: storageJsonApply,
      Config: storageJsonConfig,
    }, { root })
    await ctx.plugin({
      name: storageDomainName,
      inject: storageDomainInject,
      apply: storageDomainApply,
      Config: storageDomainConfig,
    }, { backend: 'json' })
    const tools = new Map<string, ToolDefinition>()
    await ctx.plugin({
      apply(scope) {
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

    // The engine owns branch and merge because their behavior is execution semantics; nothing else.
    assert.deepEqual(ctx.workflowNodeRegistry.listTypes().map(node => node.type).sort(), ['branch', 'merge'])
    assert.deepEqual([...tools.keys()].sort(), ['create_workflow', 'get_workflow_run', 'run_workflow'])
    assert.ok(ctx.workflowStudioController instanceof WorkflowStudioController)

    await plugin.dispose()
    assert.equal(ctx.get('dagEngine'), undefined)
    assert.equal(ctx.get('workflowNodeRegistry'), undefined)
    assert.equal(tools.size, 0)
  })

  it('保存定义时拒绝重复 ID、非法端口和缺失入边', async () => {
    const { engine } = await setup()
    const duplicateNode = linearWorkflow('duplicate')
    duplicateNode.nodes[1]!.id = NodeId('source')
    await assert.rejects(engine.save(duplicateNode), /节点 ID "source" 重复/)

    const badPort = linearWorkflow('bad-port')
    badPort.edges[0]!.targetPort = 'missing'
    await assert.rejects(engine.save(badPort), /不存在的输入端口 missing/)

    const missingInput = linearWorkflow('missing-input')
    missingInput.edges = []
    await assert.rejects(engine.save(missingInput), /输入端口 input 缺少入边/)

    const incompatible = linearWorkflow('incompatible')
    incompatible.nodes[0]!.outputs = [{ name: 'output', type: 'string' }]
    incompatible.nodes[1]!.inputs = [{ name: 'input', type: 'number' }]
    await assert.rejects(engine.save(incompatible), /端口类型不兼容/)
  })

  it('可选输入没有入边时仍执行节点', async () => {
    const { engine } = await setup()
    const id = await engine.save({
      name: 'optional-input',
      nodes: [{
        id: NodeId('pass'),
        type: 'pass',
        config: {},
        inputs: [{ name: 'input', type: 'any', required: false }],
      }],
      edges: [],
    })

    const result = await engine.start(id).result

    assert.equal(result.status, 'completed')
    assert.equal(result.nodes[0]?.status, 'completed')
  })

  it('定义和运行记录都以独立快照返回，调用方改不到引擎内部状态', async () => {
    const { engine } = await setup()
    const definition = linearWorkflow('snapshot')
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
    const alpha = linearWorkflow('alpha')
    alpha.nodes[0]!.position = { x: 24, y: 48 }
    const alphaId = await first.engine.save(alpha)
    await first.engine.save(linearWorkflow('beta'))

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

    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    const second = await setup(first.root)

    assert.deepEqual(second.engine.list().map(item => item.name).sort(), ['alpha', 'beta'])
    assert.equal(second.engine.get(alphaId)?.name, 'alpha')
    assert.deepEqual(second.engine.get(alphaId)?.nodes[0]?.position, { x: 24, y: 48 })
  })

  it('并发同名保存复用同一个 ID', async () => {
    const { engine } = await setup()
    const first = linearWorkflow('same-name')
    first.description = 'first'
    const second = linearWorkflow('same-name')
    second.description = 'second'

    const [firstId, secondId] = await Promise.all([
      engine.save(first),
      engine.save(second),
    ])

    assert.equal(firstId, secondId)
    assert.equal(engine.list().length, 1)
    assert.equal(engine.get(firstId)?.description, 'second')
  })

  it('同名保存复用 ID 并替换定义', async () => {
    const { engine } = await setup()
    const first = await engine.save(linearWorkflow('replace'))
    const replacement = linearWorkflow('replace')
    replacement.description = 'new'
    const second = await engine.save(replacement)

    assert.equal(first, second)
    assert.equal(engine.get(first)?.description, 'new')
  })

  it('工作流 ID 由名称派生，派生名相同时递增分配', async () => {
    const { engine } = await setup()

    assert.equal(await engine.save(linearWorkflow('Daily Report v2')), 'daily-report-v2')
    assert.equal(await engine.save(linearWorkflow('daily report V2')), 'daily-report-v2-2')
    // 后端只接受 [A-Za-z0-9_-]，所以全非 ASCII 名称只能共用同一个基名。
    assert.equal(await engine.save(linearWorkflow('数据处理')), 'workflow')
    assert.equal(await engine.save(linearWorkflow('数据清洗')), 'workflow-2')
  })

  it('按 ID 更新同名时保留 ID，改名时换到新名称派生的 ID', async () => {
    const { engine, root } = await setup()
    const first = await engine.save(linearWorkflow('first'))
    await engine.save(linearWorkflow('second'))

    assert.equal(await engine.update(first, linearWorkflow('first')), first)

    const renamedId = await engine.update(first, linearWorkflow('renamed'))
    assert.equal(renamedId, 'renamed')
    assert.equal(engine.get(first), undefined)
    assert.equal(engine.get(renamedId)?.name, 'renamed')
    assert.deepEqual(
      (await readdir(join(root, 'workflow_studio', 'workflows'))).sort(),
      ['renamed.json', 'second.json'],
    )

    await assert.rejects(engine.update(renamedId, linearWorkflow('second')), /名称 "second" 已存在/)
    await assert.rejects(
      engine.update(WorkflowId('missing'), linearWorkflow('renamed')),
      /工作流 "missing" 不存在/,
    )
  })

  it('节点失败时工作流失败且后续节点取消', async () => {
    const { engine } = await setup()
    const id = await engine.save({
      name: 'failure',
      nodes: [
        { id: NodeId('fail'), type: 'fail', config: {} },
        { id: NodeId('after'), type: 'pass', config: {} },
      ],
      edges: [
        { id: EdgeId('edge'), kind: 'data', source: NodeId('fail'), target: NodeId('after') },
      ],
    })

    const result = await engine.start(id).result

    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /planned failure/)
    assert.deepEqual(result.nodes.map(record => record.status), ['failed', 'cancelled'])
  })

  it('branch 的 condition 非布尔值时节点和工作流失败', async () => {
    const { engine } = await setup()
    const id = await engine.save({
      name: 'condition-invalid',
      nodes: [
        { id: NodeId('flag'), type: 'source', config: { value: 1 } },
        { id: NodeId('gate'), type: 'branch', config: {} },
      ],
      edges: [
        { id: EdgeId('flag'), kind: 'data', source: NodeId('flag'), target: NodeId('gate'), targetPort: 'condition' },
      ],
    })

    const result = await engine.start(id).result

    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /condition 输入必须为布尔值/)
  })
  it('节点上下文提供已连接的数据端口和稳定调用键', async () => {
    const { engine } = await setup()
    const id = await engine.save({
      name: 'plain-context',
      nodes: [
        { id: NodeId('value'), type: 'source', config: { value: 7 } },
        { id: NodeId('probe'), type: 'plain', config: {} },
      ],
      edges: [
        { id: EdgeId('value'), kind: 'data', source: NodeId('value'), target: NodeId('probe') },
        { id: EdgeId('order'), kind: 'exec', source: NodeId('value'), target: NodeId('probe') },
      ],
    })
    const result = await engine.start(id).result
    const probe = result.nodes.find(record => record.nodeId === NodeId('probe'))
    assert.equal(probe?.status, 'completed')
    // The execution edge supplies no input and does not appear among the connected ports.
    assert.deepEqual(probe?.outputs?.output, {
      connected: ['input'],
      invocationKey: `${result.runId}/probe`,
      inputs: { input: 7 },
    })
  })
  it('被执行边跳过的等待节点不声明请求', { timeout: 1000 }, async () => {
    const { engine } = await setup()
    const id = await engine.save({
      name: 'gated-waiter',
      nodes: [
        { id: NodeId('flag'), type: 'source', config: { value: false } },
        { id: NodeId('gate'), type: 'branch', config: {} },
        { id: NodeId('confirm'), type: 'waiter', config: {} },
      ],
      edges: [
        { id: EdgeId('flag'), kind: 'data', source: NodeId('flag'), target: NodeId('gate'), targetPort: 'condition' },
        { id: EdgeId('true-edge'), kind: 'exec', source: NodeId('gate'), sourcePort: 'true', target: NodeId('confirm') },
      ],
    })
    const result = await engine.start(id).result
    const confirm = result.nodes.find(record => record.nodeId === NodeId('confirm'))
    assert.equal(result.status, 'completed')
    assert.equal(confirm?.status, 'skipped')
    assert.equal(confirm?.requests, undefined)
  })
  it('实例声明的输入端口替换执行器声明的端口', async () => {
    const { engine } = await setup()
    const id = await engine.save({
      name: 'instance-inputs',
      nodes: [
        { id: NodeId('value'), type: 'source', config: { value: 1 } },
        { id: NodeId('sink'), type: 'pass', config: {}, inputs: [{ name: 'input', type: 'number' }] },
      ],
      edges: [
        { id: EdgeId('value'), kind: 'data', source: NodeId('value'), target: NodeId('sink') },
      ],
    })
    const result = await engine.start(id).result
    assert.equal(result.nodes.find(record => record.nodeId === NodeId('sink'))?.status, 'completed')
  })
  it('branch 分叉执行流，merge 合并选中分支的数据', async () => {
    const { engine } = await setup()
    const id = await engine.save({
      name: 'branch-merge',
      nodes: [
        { id: NodeId('compare-left'), type: 'source', config: { value: 10 } },
        { id: NodeId('compare-right'), type: 'source', config: { value: 5 } },
        { id: NodeId('greater'), type: 'greater', config: {} },
        { id: NodeId('gate'), type: 'branch', config: {} },
        { id: NodeId('left-value'), type: 'source', config: { value: 'left' } },
        { id: NodeId('right-value'), type: 'source', config: { value: 'right' } },
        { id: NodeId('left'), type: 'pass', config: {} },
        { id: NodeId('right'), type: 'pass', config: {} },
        { id: NodeId('merge'), type: 'merge', config: {} },
      ],
      edges: [
        { id: EdgeId('cl'), kind: 'data', source: NodeId('compare-left'), target: NodeId('greater'), targetPort: 'left' },
        { id: EdgeId('cr'), kind: 'data', source: NodeId('compare-right'), target: NodeId('greater'), targetPort: 'right' },
        { id: EdgeId('gate-in'), kind: 'data', source: NodeId('greater'), sourcePort: 'result', target: NodeId('gate'), targetPort: 'condition' },
        { id: EdgeId('lv'), kind: 'data', source: NodeId('left-value'), target: NodeId('left') },
        { id: EdgeId('rv'), kind: 'data', source: NodeId('right-value'), target: NodeId('right') },
        { id: EdgeId('gate-left'), kind: 'exec', source: NodeId('gate'), sourcePort: 'true', target: NodeId('left') },
        { id: EdgeId('gate-right'), kind: 'exec', source: NodeId('gate'), sourcePort: 'false', target: NodeId('right') },
        { id: EdgeId('lm'), kind: 'data', source: NodeId('left'), target: NodeId('merge'), targetPort: 'input1' },
        { id: EdgeId('rm'), kind: 'data', source: NodeId('right'), target: NodeId('merge'), targetPort: 'input2' },
        { id: EdgeId('lme'), kind: 'exec', source: NodeId('left'), target: NodeId('merge') },
        { id: EdgeId('rme'), kind: 'exec', source: NodeId('right'), target: NodeId('merge') },
      ],
    })

    const result = await engine.start(id).result

    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.equal(result.nodes.find(record => record.nodeId === NodeId('left'))?.status, 'completed')
    assert.equal(result.nodes.find(record => record.nodeId === NodeId('right'))?.status, 'skipped')
    // merge is the OR join: one dead inbound execution edge does not skip it.
    assert.equal(result.nodes.find(record => record.nodeId === NodeId('merge'))?.status, 'completed')
    assert.deepEqual(
      result.nodes.find(record => record.nodeId === NodeId('merge'))?.outputs,
      { output: 'left' },
    )
  })

  it('可变输入节点拒绝不同类型、过少输入和不同型输出', async () => {
    const { engine } = await setup()
    const base: DagWorkflowDefinition = {
      name: 'invalid-merge',
      nodes: [{
        id: NodeId('merge'),
        type: 'merge',
        config: {},
        inputs: [
          { name: 'first', type: 'number' as const, required: false },
          { name: 'second', type: 'string' as const, required: false },
        ],
        outputs: [{ name: 'output', type: 'number' as const }],
      }],
      edges: [],
    }
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
    const starved: DagWorkflowDefinition = {
      name: 'starved-input',
      nodes: [
        { id: NodeId('flag'), type: 'source', config: { value: true } },
        { id: NodeId('gate'), type: 'branch', config: {} },
        { id: NodeId('left'), type: 'source', config: { value: 1 } },
        { id: NodeId('source'), type: 'source', config: { value: 2 } },
        { id: NodeId('binary'), type: 'binary', config: {} },
      ],
      edges: [
        { id: EdgeId('flag'), kind: 'data', source: NodeId('flag'), target: NodeId('gate'), targetPort: 'condition' },
        { id: EdgeId('gate-left'), kind: 'exec', source: NodeId('gate'), sourcePort: 'true', target: NodeId('left') },
        { id: EdgeId('left'), kind: 'data', source: NodeId('left'), target: NodeId('binary'), targetPort: 'left' },
        { id: EdgeId('right'), kind: 'data', source: NodeId('source'), target: NodeId('binary'), targetPort: 'right' },
      ],
    }
    await assert.rejects(engine.save(starved), /可能被跳过，而目标节点 binary 仍会执行/)

    // Gating the consumer behind the same pin makes the wiring sound.
    starved.edges.push({
      id: EdgeId('gate-binary'),
      kind: 'exec',
      source: NodeId('gate'),
      sourcePort: 'true',
      target: NodeId('binary'),
    })
    const id = await engine.save(starved)
    const result = await engine.start(id).result
    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.deepEqual(result.nodes.find(record => record.nodeId === NodeId('binary'))?.outputs, { output: [1, 2] })
  })

  it('等待结果的节点保持 running，取消运行时结束等待', { timeout: 1000 }, async () => {
    const { ctx, engine } = await setup()
    const id = await engine.save({
      name: 'cancel-waiter',
      nodes: [{ id: NodeId('approval'), type: 'waiter', config: {} }],
      edges: [],
    })
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
    const id = await engine.save({
      name: 'parallel-waiters',
      nodes: [
        { id: NodeId('approval-a'), type: 'waiter', config: {} },
        { id: NodeId('approval-b'), type: 'waiter', config: {} },
      ],
      edges: [],
    })
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
    assert.deepEqual(result.nodes.map(record => [record.nodeId, record.status, record.error]), [
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
