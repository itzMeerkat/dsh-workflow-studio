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
import * as demoPlugin from '../src/demo/index.ts'
import { WorkflowNode } from '../src/node.ts'
import { WorkflowNodeRegistry } from '../src/registry.ts'
import { DagEngineProvider } from '../src/engine-provider.ts'
import { WorkflowStudioController } from '../src/controller.ts'
import { apply as applyPlugin, inject as pluginInject } from '../src/index.ts'
import { EdgeId, NodeId, RunId, WorkflowId } from '../src/types.ts'
import type { DagWorkflowDefinition, NodeExecutionContext, WorkflowNodeExecutor } from '../src/types.ts'

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
  protected run({ inputs }: NodeExecutionContext) { return { output: inputs.input } }
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

/** Executor whose execute() declines to run. */
const decline: WorkflowNodeExecutor = {
  type: 'decline',
  label: 'Decline',
  description: 'Returns a skipped result',
  inputs: [],
  outputs: [{ name: 'output', type: 'any' }],
  execute: () => ({ status: 'skipped' }),
}

const fail: WorkflowNodeExecutor = {
  type: 'fail',
  label: 'Fail',
  description: 'Returns a deterministic failure',
  inputs: [],
  outputs: [{ name: 'output', type: 'any' }],
  execute: () => ({ status: 'failed', error: 'planned failure' }),
}

const branch: WorkflowNodeExecutor = {
  type: 'branch',
  label: 'Branch',
  description: 'Produces only the false branch',
  inputs: [],
  outputs: [
    { name: 'true', type: 'any' },
    { name: 'false', type: 'any' },
  ],
  execute: () => ({ status: 'completed', outputs: { false: 'selected' } }),
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

const hitl: WorkflowNodeExecutor = {
  type: 'hitl',
  label: 'HITL',
  description: 'Waits for human confirmation',
  inputs: [],
  outputs: [{ name: 'output', type: 'any' }],
  requiresHumanInput: true,
  execute: () => ({ status: 'completed', outputs: { output: true } }),
}

const executors = [source, pass, plain, decline, fail, branch, binary, hitl]

function linearWorkflow(name: string): DagWorkflowDefinition {
  return {
    name,
    nodes: [
      { id: NodeId('source'), type: 'source', config: { value: 1 } },
      { id: NodeId('pass'), type: 'pass', config: {} },
    ],
    edges: [
      { id: EdgeId('edge'), source: NodeId('source'), target: NodeId('pass') },
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
    demoPlugin.registerDemoNodes(ctx)
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

  it('核心插件不注册节点，演示插件独立注册并卸载节点', async () => {
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
    const plugin = ctx.plugin({ inject: pluginInject, apply: applyPlugin })
    await plugin
    await ready.promise

    assert.deepEqual(ctx.workflowNodeRegistry.listTypes(), [])
    assert.deepEqual([...tools.keys()].sort(), ['create_workflow', 'run_workflow'])
    assert.ok(ctx.workflowStudioController instanceof WorkflowStudioController)

    const demo = ctx.plugin(demoPlugin)
    await demo
    const demoTypes = ctx.workflowNodeRegistry.listTypes()
    assert.deepEqual(demoTypes.map(item => item.type).sort(), ['arithmetic', 'coalesce', 'if', 'input', 'output'])
    assert.ok(demoTypes.every(item => item.sourcePlugin === 'dsh-workflow-studio/demo'))
    await demo.dispose()
    assert.deepEqual(ctx.workflowNodeRegistry.listTypes(), [])

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
    assert.equal(result.nodeRecords[0]?.status, 'completed')
  })

  it('保存和读取使用独立快照', async () => {
    const { engine } = await setup()
    const definition = linearWorkflow('snapshot')
    const id = await engine.save(definition)
    definition.nodes[0]!.config.value = 99

    const first = engine.get(id)
    assert.equal(first?.nodes[0]?.config.value, 1)
    first!.nodes[0]!.config.value = 100
    assert.equal(engine.get(id)?.nodes[0]?.config.value, 1)
  })

  it('每个定义写入独立文件并在重启后恢复', async () => {
    const first = await setup()
    const alpha = linearWorkflow('alpha')
    alpha.nodes[0]!.position = { x: 24, y: 48 }
    const alphaId = await first.engine.save(alpha)
    const betaId = await first.engine.save(linearWorkflow('beta'))

    const directory = join(first.root, 'workflow_studio', 'workflows')
    assert.deepEqual(
      (await readdir(directory)).sort(),
      [`${alphaId}.json`, `${betaId}.json`].sort(),
    )
    const stored = JSON.parse(await readFile(join(directory, `${alphaId}.json`), 'utf8')) as {
      version: number
      record: DagWorkflowDefinition
    }
    assert.equal(stored.version, 1)
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

  it('按 ID 更新允许重命名并拒绝占用其他工作流名称', async () => {
    const { engine } = await setup()
    const first = await engine.save(linearWorkflow('first'))
    await engine.save(linearWorkflow('second'))
    const renamed = linearWorkflow('renamed')

    assert.equal(await engine.update(first, renamed), first)
    assert.equal(engine.get(first)?.name, 'renamed')
    await assert.rejects(engine.update(first, linearWorkflow('second')), /名称 "second" 已存在/)
    await assert.rejects(
      engine.update(WorkflowId('missing'), renamed),
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
        { id: EdgeId('edge'), source: NodeId('fail'), target: NodeId('after') },
      ],
    })

    const result = await engine.start(id).result

    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /planned failure/)
    assert.deepEqual(result.nodeRecords.map(record => record.status), ['failed', 'cancelled'])
  })

  it('未选中的分支跳过下游节点', async () => {
    const { engine } = await setup()
    const id = await engine.save({
      name: 'skip',
      nodes: [
        { id: NodeId('branch'), type: 'branch', config: {} },
        { id: NodeId('sink'), type: 'pass', config: {} },
      ],
      edges: [{
        id: EdgeId('true-edge'),
        source: NodeId('branch'),
        sourcePort: 'true',
        target: NodeId('sink'),
      }],
    })

    const result = await engine.start(id).result

    assert.equal(result.status, 'completed')
    assert.equal(result.nodeRecords.find(record => record.nodeId === NodeId('sink'))?.status, 'skipped')
  })

  it('condition 为 false 时不调用执行器', async () => {
    const { engine } = await setup()
    const id = await engine.save({
      name: 'condition-false',
      nodes: [
        { id: NodeId('condition'), type: 'source', config: { value: false } },
        { id: NodeId('value'), type: 'source', config: { value: 3 } },
        { id: NodeId('sink'), type: 'pass', config: {} },
      ],
      edges: [
        {
          id: EdgeId('condition-edge'),
          source: NodeId('condition'),
          target: NodeId('sink'),
          targetPort: 'condition',
        },
        {
          id: EdgeId('value-edge'),
          source: NodeId('value'),
          target: NodeId('sink'),
        },
      ],
    })

    const result = await engine.start(id).result

    assert.equal(result.status, 'completed')
    assert.equal(result.nodeRecords.find(record => record.nodeId === NodeId('sink'))?.status, 'skipped')
  })

  it('condition 非布尔值时节点和工作流失败', async () => {
    const { engine } = await setup()
    const id = await engine.save({
      name: 'condition-invalid',
      nodes: [
        { id: NodeId('condition'), type: 'source', config: { value: 1 } },
        { id: NodeId('sink'), type: 'source', config: { value: 'unused' } },
      ],
      edges: [{
        id: EdgeId('condition-edge'),
        source: NodeId('condition'),
        target: NodeId('sink'),
        targetPort: 'condition',
      }],
    })

    const result = await engine.start(id).result

    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /condition 输入必须为布尔值/)
  })

  it('节点上下文提供已连接端口和稳定调用键，普通执行器不获得 condition 端口', async () => {
    const { engine } = await setup()
    await assert.rejects(engine.save({
      name: 'plain-condition',
      nodes: [
        { id: NodeId('flag'), type: 'source', config: { value: true } },
        { id: NodeId('probe'), type: 'plain', config: {} },
      ],
      edges: [{ id: EdgeId('flag'), source: NodeId('flag'), target: NodeId('probe'), targetPort: 'condition' }],
    }), /不存在的输入端口 condition/)

    const id = await engine.save({
      name: 'plain-context',
      nodes: [
        { id: NodeId('gate'), type: 'branch', config: {} },
        { id: NodeId('probe'), type: 'plain', config: {} },
      ],
      edges: [{ id: EdgeId('gate'), source: NodeId('gate'), sourcePort: 'true', target: NodeId('probe') }],
    })
    const result = await engine.start(id).result
    const probe = result.nodeRecords.find(record => record.nodeId === NodeId('probe'))
    assert.equal(probe?.status, 'completed')
    assert.deepEqual(probe?.outputs?.output, {
      connected: ['input'],
      invocationKey: `${result.runId}/probe`,
      inputs: {},
    })
  })

  it('execute 返回 skipped 时节点跳过且下游随之跳过', async () => {
    const { engine } = await setup()
    const id = await engine.save({
      name: 'declined',
      nodes: [
        { id: NodeId('decline'), type: 'decline', config: {} },
        { id: NodeId('sink'), type: 'pass', config: {} },
      ],
      edges: [{ id: EdgeId('edge'), source: NodeId('decline'), target: NodeId('sink') }],
    })
    const result = await engine.start(id).result
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.nodeRecords.map(record => record.status), ['skipped', 'skipped'])
  })

  it('condition 为 false 时 HITL 节点直接跳过而不暂停', { timeout: 1000 }, async () => {
    const { engine } = await setup()
    const id = await engine.save({
      name: 'gated-hitl',
      nodes: [
        { id: NodeId('flag'), type: 'source', config: { value: false } },
        { id: NodeId('confirm'), type: 'source', config: { value: 1 }, requiresHumanInput: true },
      ],
      edges: [{ id: EdgeId('flag'), source: NodeId('flag'), target: NodeId('confirm'), targetPort: 'condition' }],
    })
    const result = await engine.start(id).result
    assert.equal(result.status, 'completed')
    assert.equal(result.nodeRecords.find(record => record.nodeId === NodeId('confirm'))?.status, 'skipped')
  })

  it('实例覆盖输入端口时保留基类的 condition 端口', async () => {
    const { engine } = await setup()
    const id = await engine.save({
      name: 'instance-inputs',
      nodes: [
        { id: NodeId('flag'), type: 'source', config: { value: false } },
        { id: NodeId('value'), type: 'source', config: { value: 1 } },
        { id: NodeId('sink'), type: 'pass', config: {}, inputs: [{ name: 'input', type: 'number' }] },
      ],
      edges: [
        { id: EdgeId('flag'), source: NodeId('flag'), target: NodeId('sink'), targetPort: 'condition' },
        { id: EdgeId('value'), source: NodeId('value'), target: NodeId('sink') },
      ],
    })
    const result = await engine.start(id).result
    assert.equal(result.nodeRecords.find(record => record.nodeId === NodeId('sink'))?.status, 'skipped')
  })

  it('if 门控分支并由 coalesce 合并选中结果', async () => {
    const { engine } = await setup()
    const id = await engine.save({
      name: 'if-coalesce',
      nodes: [
        { id: NodeId('compare-left'), type: 'source', config: { value: 10 } },
        { id: NodeId('compare-right'), type: 'source', config: { value: 5 } },
        { id: NodeId('branch'), type: 'if', config: { expression: 'left > right' } },
        { id: NodeId('left-value'), type: 'source', config: { value: 'left' } },
        { id: NodeId('right-value'), type: 'source', config: { value: 'right' } },
        { id: NodeId('left'), type: 'pass', config: {} },
        { id: NodeId('right'), type: 'pass', config: {} },
        { id: NodeId('merge'), type: 'coalesce', config: {} },
      ],
      edges: [
        {
          id: EdgeId('compare-left'),
          source: NodeId('compare-left'),
          target: NodeId('branch'),
          targetPort: 'left',
        },
        {
          id: EdgeId('compare-right'),
          source: NodeId('compare-right'),
          target: NodeId('branch'),
          targetPort: 'right',
        },
        { id: EdgeId('left-value'), source: NodeId('left-value'), target: NodeId('left') },
        { id: EdgeId('right-value'), source: NodeId('right-value'), target: NodeId('right') },
        {
          id: EdgeId('left-condition'),
          source: NodeId('branch'),
          sourcePort: 'true',
          target: NodeId('left'),
          targetPort: 'condition',
        },
        {
          id: EdgeId('right-condition'),
          source: NodeId('branch'),
          sourcePort: 'false',
          target: NodeId('right'),
          targetPort: 'condition',
        },
        {
          id: EdgeId('left-merge'),
          source: NodeId('left'),
          target: NodeId('merge'),
          targetPort: 'input1',
        },
        {
          id: EdgeId('right-merge'),
          source: NodeId('right'),
          target: NodeId('merge'),
          targetPort: 'input2',
        },
      ],
    })

    const result = await engine.start(id).result

    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.equal(result.nodeRecords.find(record => record.nodeId === NodeId('left'))?.status, 'completed')
    assert.equal(result.nodeRecords.find(record => record.nodeId === NodeId('right'))?.status, 'skipped')
    assert.deepEqual(
      result.nodeRecords.find(record => record.nodeId === NodeId('merge'))?.outputs,
      { output: 'left' },
    )
  })

  it('coalesce 拒绝不同类型、过少输入和不同型输出', async () => {
    const { engine } = await setup()
    const base = {
      name: 'invalid-coalesce',
      nodes: [{
        id: NodeId('merge'),
        type: 'coalesce',
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

  it('仅部分输入可用时节点和工作流失败', async () => {
    const { engine } = await setup()
    const id = await engine.save({
      name: 'partial-input',
      nodes: [
        { id: NodeId('branch'), type: 'branch', config: {} },
        { id: NodeId('source'), type: 'source', config: { value: 2 } },
        { id: NodeId('binary'), type: 'binary', config: {} },
      ],
      edges: [
        {
          id: EdgeId('left'),
          source: NodeId('branch'),
          sourcePort: 'true',
          target: NodeId('binary'),
          targetPort: 'left',
        },
        {
          id: EdgeId('right'),
          source: NodeId('source'),
          target: NodeId('binary'),
          targetPort: 'right',
        },
      ],
    })

    const result = await engine.start(id).result

    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /缺少输入端口: left/)
  })

  it('取消暂停中的 HITL 运行会释放等待并结束', { timeout: 1000 }, async () => {
    const { ctx, engine } = await setup()
    const id = await engine.save({
      name: 'cancel-hitl',
      nodes: [{ id: NodeId('approval'), type: 'hitl', config: {} }],
      edges: [],
    })
    const paused = Promise.withResolvers<void>()
    ctx.on('dag/paused', () => { paused.resolve() })
    const run = engine.start(id)
    await paused.promise

    run.cancel('operator cancelled')
    const result = await run.result

    assert.equal(result.status, 'cancelled')
    assert.equal(result.nodeRecords[0]?.status, 'cancelled')
  })

  it('一次恢复会释放同层所有 HITL 节点', { timeout: 1000 }, async () => {
    const { ctx, engine } = await setup()
    const id = await engine.save({
      name: 'parallel-hitl',
      nodes: [
        { id: NodeId('approval-a'), type: 'hitl', config: {} },
        { id: NodeId('approval-b'), type: 'hitl', config: {} },
      ],
      edges: [],
    })
    let pausedCount = 0
    const bothPaused = Promise.withResolvers<void>()
    const run = engine.start(id)
    ctx.on('dag/paused', () => {
      pausedCount += 1
      if (pausedCount === 2) bothPaused.resolve()
    })
    await bothPaused.promise

    run.resume()
    const result = await run.result

    assert.equal(result.status, 'completed')
    assert.equal(pausedCount, 2)
    assert.deepEqual(result.nodeRecords.map(record => record.status), ['completed', 'completed'])
  })

  it('完成结果和 getRun 返回值不能修改内部记录', async () => {
    const { engine } = await setup()
    const id = await engine.save(linearWorkflow('result-snapshot'))
    const run = engine.start(id)
    const result = await run.result
    result.nodeRecords[0]!.status = 'failed'

    const firstRead = engine.getRun(run.runId)
    assert.equal(firstRead?.nodeRecords[0]?.status, 'completed')
    firstRead!.nodeRecords[0]!.status = 'failed'
    assert.equal(engine.getRun(run.runId)?.nodeRecords[0]?.status, 'completed')
  })

  it('未知工作流和运行 ID 返回明确结果', async () => {
    const { engine } = await setup()
    assert.throws(() => engine.start(WorkflowId('missing')), /未找到/)
    assert.equal(engine.getRun(RunId('missing')), undefined)
  })
})
