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
import { registerFixtureNodes } from './fixture-nodes.ts'
import { runEnded } from './host.ts'
import { RunId } from '../src/shared/types.ts'
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
    registerFixtureNodes(ctx)
    await ctx.plugin(DagEngineProvider)
    return new WorkflowStudioController(ctx)
  }

  it('保存定义、列出节点并返回完整运行结果', async () => {
    const controller = await setup()
    const workflowId = await controller.save(JSON.stringify({
      name: 'sum',
      nodes: [
        { id: 'left', type: 'value', config: { value: 10 }, position: { x: 24, y: 48 } },
        { id: 'right', type: 'value', config: { value: 20 } },
        { id: 'add', type: 'sum', config: { offset: 0 } },
      ],
      edges: [
        { id: 'left-add', kind: 'data', source: 'left', target: 'add', targetPort: 'left' },
        { id: 'right-add', kind: 'data', source: 'right', target: 'add', targetPort: 'right' },
      ],
    }))

    const snapshot = JSON.parse(controller.snapshot()) as {
      workflows: Array<{ id: string; name: string }>
      nodeTypes: Array<{
        type: string
        sourcePlugin: string
        inputs: Array<{ name: string }>
        outputs: Array<{ name: string; display?: string }>
        execOutputs: string[]
        controls: Array<{ name: string; kind: string }>
      }>
    }
    assert.deepEqual(
      snapshot.workflows.map(({ id, name }) => ({ id, name })),
      [{ id: workflowId, name: 'sum' }],
    )
    assert.deepEqual(
      snapshot.nodeTypes.map(node => node.type).sort(),
      ['ask', 'branch', 'greater', 'merge', 'sum', 'value'],
    )
    const sum = snapshot.nodeTypes.find(node => node.type === 'sum')
    assert.equal(sum?.sourcePlugin, 'test-fixtures')
    assert.deepEqual(sum?.inputs.map(port => port.name), ['left', 'right'])
    assert.deepEqual(sum?.execOutputs, ['then'])
    assert.deepEqual(sum?.outputs.map(port => port.name), ['result'])
    assert.equal(sum?.outputs[0]?.display, 'value')
    assert.deepEqual(sum?.controls.map(control => [control.name, control.kind]), [['offset', 'number']])
    const greater = snapshot.nodeTypes.find(node => node.type === 'greater')
    assert.deepEqual(greater?.inputs.map(port => port.name), ['left', 'right'])
    const gate = snapshot.nodeTypes.find(node => node.type === 'branch')
    assert.deepEqual(gate?.execOutputs, ['true', 'false'])
    const savedDefinition = JSON.parse(
      (JSON.parse(controller.snapshot()) as { workflows: Array<{ definition: string }> }).workflows[0]!.definition,
    ) as { nodes: Array<{ id: string; position?: { x: number; y: number } }> }
    assert.deepEqual(savedDefinition.nodes.find(node => node.id === 'left')?.position, { x: 24, y: 48 })

    const runId = RunId(controller.start(workflowId))
    const result = await runEnded(contexts.at(-1)!, runId)
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.nodes.find(node => node.nodeId === 'add')?.outputs, { result: 30 })
  })

  it('等待中的请求经 signal Remote 校验后送达结果', async () => {
    const controller = await setup()
    const workflowId = await controller.save(JSON.stringify({
      name: 'ask',
      nodes: [{ id: 'ask', type: 'ask', config: {} }],
      edges: [],
    }))
    const runId = RunId(controller.start(workflowId))
    const record = () => JSON.parse(controller.getRun(runId)) as {
      nodes: Array<{ status: string; requests?: Array<{ id: string; request: { kind: string }; result?: unknown }> }>
    }
    for (let tick = 0; tick < 200 && record().nodes[0]?.requests === undefined; tick++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const pending = record().nodes[0]!
    assert.equal(pending.status, 'running')
    assert.deepEqual(pending.requests?.map(item => [item.id, item.request.kind]), [['pick', 'questions']])

    await assert.rejects(
      controller.signal(runId, 'ask', 'pick', JSON.stringify({ answers: [] })),
      /缺少问题 "decision"/,
    )
    const answer = { answers: [{ id: 'decision', selected: ['yes'] }] }
    const after = JSON.parse(await controller.signal(runId, 'ask', 'pick', JSON.stringify(answer))) as {
      nodes: Array<{ requests?: Array<{ result?: unknown }> }>
    }
    assert.deepEqual(after.nodes[0]?.requests?.[0]?.result, answer)

    const result = await runEnded(contexts.at(-1)!, runId)
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.nodes[0]?.outputs, { answer: 'yes' })
  })

  it('按 ID 更新定义时保留工作流身份并允许重命名', async () => {
    const controller = await setup()
    const source = {
      name: 'before',
      nodes: [{ id: 'input', type: 'value', config: { value: 1 } }],
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
