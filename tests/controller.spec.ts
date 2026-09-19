/**
 * Browser Remote controller tests.
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
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
import { registerDemoNodes } from '../src/demo/index.ts'
import { WorkflowStudioController } from '../src/controller.ts'
import { DagEngineProvider } from '../src/engine-provider.ts'
import { WorkflowNodeRegistry } from '../src/registry.ts'

describe('WorkflowStudioController', () => {
  const contexts: Context[] = []
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
    await Promise.all(roots.splice(0).map(async root => rm(root, { recursive: true, force: true })))
  })

  async function setup(): Promise<WorkflowStudioController> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-controller-'))
    roots.push(root)
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
    registerDemoNodes(ctx)
    await ctx.plugin(DagEngineProvider)
    return new WorkflowStudioController(ctx)
  }

  it('保存定义、列出节点并返回完整运行结果', async () => {
    const controller = await setup()
    const workflowId = await controller.save(JSON.stringify({
      name: 'sum',
      nodes: [
        { id: 'left', type: 'input', config: { defaultValue: 10 }, position: { x: 24, y: 48 } },
        { id: 'right', type: 'input', config: { defaultValue: 20 } },
        { id: 'add', type: 'arithmetic', config: { operator: 'add' } },
        { id: 'result', type: 'output', config: {} },
      ],
      edges: [
        { id: 'left-add', source: 'left', target: 'add', targetPort: 'left' },
        { id: 'right-add', source: 'right', target: 'add', targetPort: 'right' },
        { id: 'add-result', source: 'add', sourcePort: 'result', target: 'result' },
      ],
    }))

    const snapshot = JSON.parse(controller.snapshot()) as {
      workflows: Array<{ id: string; name: string }>
      nodeTypes: Array<{
        type: string
        sourcePlugin: string
        inputs: Array<{ name: string }>
        outputs: Array<{ name: string; display?: string }>
        controls: Array<{ name: string; kind: string }>
      }>
    }
    assert.deepEqual(
      snapshot.workflows.map(({ id, name }) => ({ id, name })),
      [{ id: workflowId, name: 'sum' }],
    )
    assert.deepEqual(
      snapshot.nodeTypes.map(node => node.type).sort(),
      ['arithmetic', 'coalesce', 'if', 'input', 'output'],
    )
    const arithmetic = snapshot.nodeTypes.find(node => node.type === 'arithmetic')
    assert.equal(arithmetic?.sourcePlugin, 'dsh-workflow-studio/demo')
    assert.deepEqual(arithmetic?.inputs.map(port => port.name), ['left', 'right', 'condition'])
    assert.deepEqual(arithmetic?.outputs.map(port => port.name), ['result'])
    assert.equal(arithmetic?.outputs[0]?.display, 'value')
    assert.deepEqual(arithmetic?.controls.map(control => [control.name, control.kind]), [
      ['operator', 'select'],
    ])
    const ifNode = snapshot.nodeTypes.find(node => node.type === 'if')
    assert.deepEqual(ifNode?.inputs.map(port => port.name), ['left', 'right'])
    assert.deepEqual(ifNode?.controls.map(control => [control.name, control.kind]), [
      ['expression', 'text'],
    ])
    const savedDefinition = JSON.parse(
      (JSON.parse(controller.snapshot()) as { workflows: Array<{ definition: string }> }).workflows[0]!.definition,
    ) as { nodes: Array<{ id: string; position?: { x: number; y: number } }> }
    assert.deepEqual(savedDefinition.nodes.find(node => node.id === 'left')?.position, { x: 24, y: 48 })

    const result = JSON.parse(await controller.run(workflowId)) as {
      status: string
      nodeRecords: Array<{ nodeId: string; outputs?: Record<string, unknown> }>
    }
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.nodeRecords.find(node => node.nodeId === 'result')?.outputs, { output: 30 })
  })

  it('按 ID 更新定义时保留工作流身份并允许重命名', async () => {
    const controller = await setup()
    const source = {
      name: 'before',
      nodes: [{ id: 'input', type: 'input', config: { defaultValue: 1 } }],
      edges: [],
    }
    const workflowId = await controller.save(JSON.stringify(source))

    assert.equal(
      await controller.update(workflowId, JSON.stringify({ ...source, name: 'after' })),
      workflowId,
    )
    const snapshot = JSON.parse(controller.snapshot()) as {
      workflows: Array<{ id: string; name: string }>
    }
    assert.deepEqual(
      snapshot.workflows.map(({ id, name }) => ({ id, name })),
      [{ id: workflowId, name: 'after' }],
    )
  })

  it('拒绝无效 JSON 和未注册节点', async () => {
    const controller = await setup()
    await assert.rejects(controller.save('{'), /JSON/)
    await assert.rejects(
      controller.save(JSON.stringify({
        name: 'bad',
        nodes: [{ id: 'node', type: 'missing', config: {} }],
        edges: [],
      })),
      /未知节点类型/,
    )
  })
})
