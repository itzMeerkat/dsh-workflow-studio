/**
 * 子工作流：端口来自被嵌入的工作流，嵌入不能成环，运行时展开。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { WorkflowStudioController } from '../src/controller.ts'
import { SUBWORKFLOW_FIELD, SUBWORKFLOW_TYPE, subworkflowPorts, withSubworkflows } from '../src/shared/subworkflow.ts'
import { NodeId, RunId, WorkflowId, type SavedWorkflow } from '../src/shared/types.ts'
import { WORKFLOW_INPUT_TYPE, WORKFLOW_OUTPUT_TYPE } from '../src/shared/workflow-boundary.ts'
import { createFixtureNodes } from './fixture-nodes.ts'
import { workflow } from './graph-fixtures.ts'
import { TestHosts, runEnded } from './host.ts'

const idOf = (saved: SavedWorkflow): string => saved.workflowId

const embed = (id: string) => ({ type: SUBWORKFLOW_TYPE, config: { [SUBWORKFLOW_FIELD]: id } })

/** 把 `x` 与 `offset` 相加；`offset` 有默认值 5。 */
const ADD_OFFSET = workflow({
  in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'x', type: 'number' }, { name: 'offset', type: 'number', default: 5 }] },
  add: 'sum',
  out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [{ name: 'y', type: 'number', required: false }] },
}, ['in:x>add:left', 'in:offset>add:right', 'add:result>out:y'], { name: 'add-offset' })

describe('子工作流的端口与嵌入规则', () => {
  it('端口是被嵌入工作流的输入和输出，有默认值的输入可以不接线；接在已不存在的端口上的边被去掉', () => {
    assert.deepEqual(subworkflowPorts(ADD_OFFSET), {
      inputs: [{ name: 'x', type: 'number' }, { name: 'offset', type: 'number', required: false }],
      outputs: [{ name: 'y', type: 'number' }],
    })

    const parent = workflow({ sub: embed('add-offset'), out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [{ name: 'y', type: 'number' }] } },
      ['sub:y>out:y', 'sub:gone>out:y'])
    const linked = withSubworkflows(parent, id => id === WorkflowId('add-offset') ? ADD_OFFSET : undefined)
    assert.deepEqual(linked.nodes[0]?.inputs, [{ name: 'x', type: 'number' }, { name: 'offset', type: 'number', required: false }])
    assert.deepEqual(linked.nodes[0]?.outputs, [{ name: 'y', type: 'number' }])
    assert.deepEqual(linked.edges.map(edge => edge.id), ['e0'])
    assert.equal(withSubworkflows(linked, () => undefined), linked)
  })
})

describe('运行中的子工作流', () => {
  const hosts = new TestHosts()
  let host: Context

  afterEach(async () => {
    await hosts.cleanup()
  })

  async function setup(): Promise<WorkflowStudioController> {
    const { ctx } = await hosts.start(await hosts.root(), createFixtureNodes())
    host = ctx
    const controller = new WorkflowStudioController(ctx)
    await controller.save(ADD_OFFSET)
    return controller
  }

  /** 把 10 送进 `add-offset`，读回它的 `y`；`gate` 决定子工作流是否运行。 */
  const parent = (gated: boolean) => workflow({
    ten: { type: 'value', config: { value: 10 } },
    ...gated ? { one: { type: 'value', config: { value: 1 } }, check: 'greater', gate: 'branch' } : {},
    sub: { ...embed('add-offset'), inputs: [{ name: 'x', type: 'number' }, { name: 'offset', type: 'number', required: false }], outputs: [{ name: 'y', type: 'number' }] },
    out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [{ name: 'total', type: 'number', required: false }] },
  }, [
    'ten>sub:x', 'sub:y>out:total',
    ...gated ? ['one>check:left', 'ten>check:right', 'check:result>gate:condition', 'gate.true>sub'] : [],
  ], { name: gated ? 'gated' : 'parent' })

  it('运行时展开成被嵌入工作流的节点：未接线的输入取默认值，输出送回嵌入处', async () => {
    const controller = await setup()
    const record = await runEnded(host, RunId(controller.start(idOf(await controller.save(parent(false))), {})))
    assert.equal(record.status, 'completed')
    assert.deepEqual(record.outputs, { total: 15 })
    assert.deepEqual(record.nodes.find(node => node.nodeId === 'sub/add')?.outputs, { result: 15 })
  })

  it('不存在的、成环的嵌入照样保存，运行开始时失败；被嵌入的工作流只能做不换 ID 的改名', async () => {
    const controller = await setup()
    const broken = idOf(await controller.save(workflow({ sub: embed('nope') }, [], { name: 'broken' })))
    assert.throws(() => controller.start(broken, {}), /工作流 nope 不存在/)
    const embedder = idOf(await controller.save(parent(false)))
    await controller.update('add-offset', { ...ADD_OFFSET, nodes: [...ADD_OFFSET.nodes, { id: NodeId('back'), ...embed('parent') }] })
    assert.throws(() => controller.start(embedder, {}), /子工作流嵌入成环/)
    await controller.update('add-offset', ADD_OFFSET)
    await assert.rejects(controller.update('add-offset', { ...ADD_OFFSET, name: 'renamed' }), /被 "parent" 作为子工作流嵌入，不能改名/)
    assert.equal(idOf(await controller.update('add-offset', { ...ADD_OFFSET, name: 'Add Offset' })), 'add-offset')
  })
})
