/**
 * Browser Remote controller tests.
 */

import assert from 'node:assert/strict'
import { afterEach,describe,it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { createFixtureNodes } from './fixture-nodes.ts'
import { workflow } from './graph-fixtures.ts'
import { TestHosts,runEnded } from './host.ts'
import { SUBWORKFLOW_ENTRY_TYPE } from '../src/shared/subworkflow.ts'
import { RunId,type DagWorkflowDefinition,type SavedWorkflow } from '../src/shared/types.ts'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { WorkflowStudioController } from '../src/controller.ts'

describe('WorkflowStudioController', () => {
  const hosts = new TestHosts()
  let host: Context

  afterEach(async () => { await hosts.cleanup() })

  async function setup(): Promise<WorkflowStudioController> {
    const { ctx } = await hosts.start(await hosts.root(), createFixtureNodes())
    host = ctx
    return new WorkflowStudioController(ctx)
  }

  /** 保存结果中的工作流 ID。 */
  const idOf = (saved: SavedWorkflow): string => saved.workflowId

  /** 快照中第一个工作流保存下来的定义。 */
  function savedDefinition(controller: WorkflowStudioController): DagWorkflowDefinition {
    return controller.snapshot().workflows[0]!.definition
  }

  it('保存定义、列出节点并返回完整运行结果', async () => {
    const controller = await setup()
    const workflowId = idOf(await controller.save(workflow({
      left: { type: 'value', config: { value: 10 }, position: { x: 24, y: 48 } },
      right: { type: 'value', config: { value: 20 } },
      add: { type: 'sum', config: { offset: 0 } },
    }, ['left>add:left', 'right>add:right'], { name: 'sum' })))

    const snapshot = controller.snapshot()
    assert.deepEqual(
      snapshot.workflows.map(({ id, name }) => ({ id, name })),
      [{ id: workflowId, name: 'sum' }],
    )
    assert.deepEqual(
      snapshot.nodeTypes.map(node => node.type).sort(),
      [
        'ask', 'branch', 'greater', 'merge', 'subworkflow',
        'subworkflow-entry', 'subworkflow-exit', 'sum', 'switch', 'value', 'workflow-input', 'workflow-output',
      ],
    )
    const sum = snapshot.nodeTypes.find(node => node.type === 'sum')
    assert.equal(sum?.sourcePlugin, 'engine-tests')
    assert.deepEqual(sum?.inputs.map(port => port.name), ['left', 'right'])
    assert.deepEqual(sum?.execOutputs, ['then'])
    assert.deepEqual(sum?.outputs.map(port => port.name), ['result'])
    assert.equal(sum?.outputs[0]?.display, 'value')
    assert.deepEqual(sum?.controls.map(control => [control.name, control.kind]), [['offset', 'number']])
    const greater = snapshot.nodeTypes.find(node => node.type === 'greater')
    assert.deepEqual(greater?.inputs.map(port => port.name), ['left', 'right'])
    const gate = snapshot.nodeTypes.find(node => node.type === 'branch')
    assert.deepEqual(gate?.execOutputs, ['true', 'false'])
    assert.deepEqual(savedDefinition(controller).nodes.find(node => node.id === 'left')?.position, { x: 24, y: 48 })

    const result = await runEnded(host, RunId(controller.start(workflowId, {})))
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.nodes.find(node => node.nodeId === 'add')?.outputs, { result: 30 })
  })

  it('较早记录的种类、语言和原子目录字段在保存时被丢弃，只由子工作流展开放置的节点不能直接使用', async () => {
    const controller = await setup()
    await controller.save({ ...workflow({ v: { type: 'value', config: { value: 1 } } }, [], { name: 'legacy' }), kind: 'run', language: 'go', atomFolder: '/atoms' })
    assert.deepEqual(Object.keys(savedDefinition(controller)).sort(), ['edges', 'name', 'nodes'])

    await assert.rejects(controller.save(workflow({ entry: SUBWORKFLOW_ENTRY_TYPE }, [], { name: 'entry' })), {
      code: 'workflowStudio/refused',
      details: { refusal: { code: 'node-reserved', type: SUBWORKFLOW_ENTRY_TYPE } },
    })
  })

  it('作者能改正的拒绝带着类别报告，不合 schema 的值是错误请求，其余是意外', async () => {
    const controller = await setup()
    await assert.rejects(controller.save({ name: 'no-graph' }), { code: 'gateway/bad-request', message: /nodes/ })
    await assert.rejects(controller.save(workflow({ node: 'missing' }, [], { name: 'bad' })), {
      code: 'workflowStudio/refused',
      message: '未知节点类型: missing',
      details: { refusal: { code: 'node-type-unknown', type: 'missing' } },
    })
    assert.throws(() => controller.getRun('gone'), { code: 'workflowStudio/refused', details: { refusal: { code: 'run-missing', run: 'gone' } } })
    // 引擎关闭后的写入失败不是作者能改正的，所以不带拒绝的类别，交给 Gateway 报告为内部错误。
    await hosts.stop(host)
    await assert.rejects(controller.save(workflow({ v: 'value' }, [], { name: 'late' })), (error: unknown) =>
      error instanceof Error && remoteErrorOf(error) === undefined)
  })
})
