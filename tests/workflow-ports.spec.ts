/**
 * 工作流边界节点测试：输入值进入图中、输出被收集，以及边界节点独有的校验。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TestHosts, runEnded } from './host.ts'
import { createFixtureNodes } from './fixture-nodes.ts'
import { workflow } from './graph-fixtures.ts'
import type { DagWorkflowDefinition } from '../src/shared/types.ts'
import { WORKFLOW_INPUT_TYPE, WORKFLOW_OUTPUT_TYPE } from '../src/shared/workflow-boundary.ts'

describe('工作流边界节点', () => {
  const hosts = new TestHosts()
  afterEach(async () => { await hosts.cleanup() })

  /** left 与 right 取自工作流输入，结果送到工作流输出。 */
  function ioWorkflow(): DagWorkflowDefinition {
    return workflow({
      in: {
        type: WORKFLOW_INPUT_TYPE,
        outputs: [{ name: 'left', type: 'number' }, { name: 'right', type: 'number', default: 5 }],
      },
      add: { type: 'sum', config: { offset: 0 } },
      out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [{ name: 'total', type: 'number', required: false }] },
    }, ['in:left>add:left', 'in:right>add:right', 'add:result>out:total'], { name: 'io' })
  }

  it('调用方提供的输入进入图中，缺省的输入用声明的默认值', async () => {
    const { ctx, engine } = await hosts.start(await hosts.root(), createFixtureNodes())
    const workflowId = await engine.save(ioWorkflow())

    const record = await runEnded(ctx, engine.start(workflowId, { left: 3 }).runId)

    assert.equal(record.status, 'completed')
    assert.deepEqual(record.outputs, { total: 8 })
    assert.deepEqual(record.nodes.find(node => node.nodeId === 'in')?.outputs, { left: 3, right: 5 })
  })

  it('缺少没有默认值的输入，或提供未声明的输入，运行无法开始', async () => {
    const { engine } = await hosts.start(await hosts.root(), createFixtureNodes())
    const workflowId = await engine.save(ioWorkflow())

    assert.throws(() => engine.start(workflowId), /工作流输入 "left" 未提供值/)
    assert.throws(() => engine.start(workflowId, { left: 1, other: 2 }), /工作流未声明输入 "other"/)
  })

  it('没有输入边界节点的工作流拒绝任何输入值', async () => {
    const { ctx, engine } = await hosts.start(await hosts.root(), createFixtureNodes())
    const workflowId = await engine.save(workflow(
      { value: { type: 'value', config: { value: 1 } } },
      [],
      { name: 'plain' },
    ))

    assert.throws(() => engine.start(workflowId, { left: 1 }), /工作流未声明输入 "left"/)
    const record = await runEnded(ctx, engine.start(workflowId).runId)
    assert.equal(record.outputs, undefined)
  })

  it('未接线的声明输出不阻止保存，也不出现在运行输出中', async () => {
    const { ctx, engine } = await hosts.start(await hosts.root(), createFixtureNodes())
    const workflowId = await engine.save(workflow({
      value: { type: 'value', config: { value: 7 } },
      out: {
        type: WORKFLOW_OUTPUT_TYPE,
        inputs: [
          { name: 'answer', type: 'any', required: false },
          { name: 'unused', type: 'any', required: false },
        ],
      },
    }, ['value:output>out:answer'], { name: 'partial' }))

    const record = await runEnded(ctx, engine.start(workflowId).runId)

    assert.equal(record.status, 'completed')
    assert.deepEqual(record.outputs, { answer: 7 })
  })

  it('执行边可以门控输出边界，未触发的一侧让运行不产出任何输出', async () => {
    const { ctx, engine } = await hosts.start(await hosts.root(), createFixtureNodes())
    const workflowId = await engine.save(workflow({
      in: {
        type: WORKFLOW_INPUT_TYPE,
        outputs: [{ name: 'left', type: 'number', default: 1 }, { name: 'right', type: 'number', default: 2 }],
      },
      check: 'greater',
      gate: 'branch',
      out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [{ name: 'verdict', type: 'any', required: false }] },
    }, [
      'in:left>check:left',
      'in:right>check:right',
      'check:result>gate:condition',
      'check:result>out:verdict',
      'gate.true>out',
    ], { name: 'gated-output' }))

    const refused = await runEnded(ctx, engine.start(workflowId, { left: 1, right: 2 }).runId)
    const taken = await runEnded(ctx, engine.start(workflowId, { left: 5, right: 2 }).runId)

    // 1 > 2 is false, so the true pin never fires and the outputs node is skipped with it.
    assert.equal(refused.nodes.find(node => node.nodeId === 'out')?.status, 'skipped')
    assert.equal(refused.outputs, undefined)
    assert.deepEqual(taken.outputs, { verdict: true })
  })

  it('保存拒绝同一侧的第二个边界节点', async () => {
    const { engine } = await hosts.start(await hosts.root(), createFixtureNodes())

    await assert.rejects(engine.save(workflow(
      { a: { type: WORKFLOW_INPUT_TYPE, outputs: [] }, b: { type: WORKFLOW_INPUT_TYPE, outputs: [] } },
      [],
      { name: 'two-inputs' },
    )), /工作流最多只能有一个输入边界节点/)
  })
})
