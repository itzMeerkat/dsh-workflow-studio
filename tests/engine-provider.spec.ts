/**
 * DAG 引擎默认实现测试。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { TestHosts } from './host.ts'
import { createFixtureNodes } from './fixture-nodes.ts'
import { workflow } from './graph-fixtures.ts'
import { WorkflowNode, type WorkflowNodePorts } from '../src/node.ts'
import { WorkflowNodeRegistry } from '../src/registry.ts'
import { DagEngineProvider } from '../src/engine-provider.ts'
import { WorkflowStudioController } from '../src/controller.ts'
import { Config as PluginConfig, apply as applyPlugin, inject as pluginInject } from '../src/index.ts'
import { EdgeId, NodeId, WorkflowId } from '../src/shared/types.ts'
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
    outputs: { output: { connected: [...connected], invocationKey, inputs } },
  }),
}

const fail: WorkflowNodeExecutor = {
  type: 'fail',
  label: 'Fail',
  description: 'Throws a deterministic error',
  inputs: [],
  outputs: [{ name: 'output', type: 'any' }],
  execute: () => { throw new Error('planned failure') },
}

const binary: WorkflowNodeExecutor = {
  type: 'binary',
  label: 'Binary',
  description: 'Requires two inputs',
  inputs: [{ name: 'left', type: 'any' }, { name: 'right', type: 'any' }],
  outputs: [{ name: 'output', type: 'any' }],
  execute: ({ inputs }) => ({ outputs: { output: [inputs.left, inputs.right] } }),
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
      throw new Error('外部结果为拒绝')
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

  it('核心插件按声明依赖加载，只注册流程控制、边界和子工作流节点，并随卸载移除服务和工具', async () => {
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
    // The engine owns the node types whose behavior is execution semantics or the workflow's own
    // boundary; nothing else.
    assert.deepEqual(
      ctx.workflowNodeRegistry.listTypes().map(node => node.type).sort(),
      [
        'branch', 'merge', 'subworkflow', 'subworkflow-entry', 'subworkflow-exit', 'switch',
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

  it('按 ID 更新同名时保留 ID，改名时换到新名称派生的 ID，派生出原 ID 的改名不换 ID', async () => {
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
    assert.equal(await engine.update(renamedId, linear('Renamed')), renamedId)
    assert.equal(engine.get(renamedId)?.name, 'Renamed')
    assert.deepEqual(
      (await readdir(join(root, 'workflow_studio', 'workflows'))).sort(),
      ['renamed.json', 'second.json'],
    )

    await assert.rejects(engine.update(renamedId, linear('second')), /名称 "second" 已存在/)
    await assert.rejects(engine.update(WorkflowId('missing'), linear('renamed')), /工作流 "missing" 不存在/)
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
})
