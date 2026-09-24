/**
 * 子工作流：端口来自被嵌入的工作流，保存时检查嵌入关系，`run` 工作流运行时展开，`code` 工作流写成函数调用。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { WorkflowStudioController } from '../src/controller.ts'
import { NO_CALLEES, withCallees } from '../src/shared/callees.ts'
import { GO } from '../src/shared/language.ts'
import { RenderError, renderWorkflow } from '../src/shared/source.ts'
import {
  SUBWORKFLOW_FIELD, SUBWORKFLOW_TYPE, embedFault, workflowSignature,
} from '../src/shared/subworkflow.ts'
import { NodeId, RunId, WorkflowId, type DagWorkflowDefinition } from '../src/shared/types.ts'
import { WORKFLOW_INPUT_TYPE, WORKFLOW_OUTPUT_TYPE } from '../src/shared/workflow-boundary.ts'
import { createFixtureNodes } from './fixture-nodes.ts'
import { NODE_TYPES, irOf, nodeType, workflow } from './graph-fixtures.ts'
import { indexNodeTypes } from '../src/shared/analysis.ts'
import { TestHosts, runEnded } from './host.ts'

const idOf = (saved: string): string => (JSON.parse(saved) as { workflowId: string }).workflowId

const embed = (id: string) => ({ type: SUBWORKFLOW_TYPE, config: { [SUBWORKFLOW_FIELD]: id } })

/** 把 `x` 与 `offset` 相加；`offset` 有默认值 5。 */
const ADD_OFFSET = workflow({
  in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'x', type: 'number' }, { name: 'offset', type: 'number', default: 5 }] },
  add: 'sum',
  out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [{ name: 'y', type: 'number', required: false }] },
}, ['in:x>add:left', 'in:offset>add:right', 'add:result>out:y'], { name: 'add-offset' })

describe('子工作流的端口与嵌入规则', () => {
  it('端口是被嵌入工作流的输入和输出；run 工作流有默认值的输入可以不接线，code 工作流的输入都要接线', () => {
    assert.deepEqual(workflowSignature(ADD_OFFSET), {
      name: 'add-offset',
      parameters: [{ name: 'x', type: 'number', optional: false }, { name: 'offset', type: 'number', optional: true }],
      results: [{ name: 'y', type: 'number' }],
    })
    assert.equal(workflowSignature({ ...ADD_OFFSET, kind: 'code' }).parameters[1]?.optional, false)

    const parent = workflow({ sub: embed('add-offset'), out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [{ name: 'y', type: 'number' }] } },
      ['sub:y>out:y', 'sub:gone>out:y'])
    const linked = withCallees(parent, { ...NO_CALLEES, workflows: new Map([[WorkflowId('add-offset'), ADD_OFFSET]]) })
    assert.deepEqual(linked.nodes[0]?.inputs, [{ name: 'x', type: 'number' }, { name: 'offset', type: 'number', required: false }])
    assert.deepEqual(linked.nodes[0]?.outputs, [{ name: 'y', type: 'number' }])
    assert.deepEqual(linked.edges.map(edge => edge.id), ['e0'])
  })

  it('只能嵌入同种类、不形成环的工作流；code 工作流还须同一语言和原子目录', () => {
    const parent = workflow({ sub: embed('add-offset') }, [], { name: 'parent' })
    const saved = new Map([[WorkflowId('parent'), parent], [WorkflowId('add-offset'), ADD_OFFSET]])
    const lookup = (id: WorkflowId) => saved.get(id)
    assert.equal(embedFault(parent, WorkflowId('parent'), WorkflowId('add-offset'), ADD_OFFSET, lookup, false), undefined)
    assert.equal(embedFault(ADD_OFFSET, WorkflowId('add-offset'), WorkflowId('parent'), parent, lookup, false), 'cycle')
    assert.equal(embedFault(parent, WorkflowId('parent'), WorkflowId('parent'), parent, lookup, false), 'cycle')

    const code = (atomFolder: string): DagWorkflowDefinition => ({ ...ADD_OFFSET, kind: 'code', language: 'go', atomFolder })
    assert.equal(embedFault(parent, undefined, WorkflowId('c'), code('/a'), lookup, false), 'other-kind')
    assert.equal(embedFault(code('/a'), undefined, WorkflowId('c'), code('/b'), lookup, true), 'other-package')
    assert.equal(embedFault(code('/a'), undefined, WorkflowId('c'), code('/a'), lookup, false), 'no-calls')
    assert.equal(embedFault(code('/a'), undefined, WorkflowId('c'), code('/a'), lookup, true), undefined)
  })
})

describe('code 工作流中的子工作流', () => {
  const CATALOG = indexNodeTypes([
    ...NODE_TYPES.map(type => ({ ...type, kinds: ['run', 'code'] as const })),
    nodeType(SUBWORKFLOW_TYPE, { kinds: ['run', 'code'] }),
  ])
  const discount = workflow({
    in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'amount', type: 'number' }] },
    out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [{ name: 'price', type: 'number', required: false }] },
  }, ['in:amount>out:price'], { name: 'Discount', kind: 'code', language: 'go' })
  const callees = { ...NO_CALLEES, workflows: new Map([[WorkflowId('discount'), discount]]) }
  const checkout = withCallees(workflow({
    in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'amount', type: 'number' }] },
    cut: embed('discount'),
    out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [{ name: 'price', type: 'number', required: false }] },
  }, ['in:amount>cut:amount', 'cut:price>out:price'], { name: 'Checkout', kind: 'code', language: 'go' }), callees)

  it('写成对被嵌入工作流生成的函数的调用，函数名与它自己生成时相同', () => {
    assert.equal(renderWorkflow(irOf(checkout, CATALOG), GO, callees), [
      '// Code generated from workflow "Checkout". DO NOT EDIT.',
      '',
      'func Checkout(amount float64) (price float64) {',
      '\tvar Discount_price float64',
      '\tDiscount_price = Discount(amount)',
      '\tprice = Discount_price',
      '\treturn',
      '}',
      '',
    ].join('\n'))
    assert.match(renderWorkflow(irOf(discount, CATALOG), GO, callees), /^func Discount\(/m)
  })

  it('被嵌入的工作流不存在时指出节点', () => {
    assert.throws(() => renderWorkflow(irOf(checkout, CATALOG), GO, NO_CALLEES), (error: unknown) =>
      error instanceof RenderError && error.fault.code === 'missing-workflow' && error.fault.node === NodeId('cut'))
  })
})

describe('run 工作流中的子工作流', () => {
  const hosts = new TestHosts()
  let host: Context

  afterEach(async () => {
    await hosts.cleanup()
  })

  async function setup(): Promise<WorkflowStudioController> {
    const { ctx } = await hosts.start(await hosts.root(), createFixtureNodes())
    host = ctx
    const controller = new WorkflowStudioController(ctx)
    await controller.save(JSON.stringify(ADD_OFFSET))
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
    const record = await runEnded(host, RunId(controller.start(idOf(await controller.save(JSON.stringify(parent(false)))))))
    assert.equal(record.status, 'completed')
    assert.deepEqual(record.outputs, { total: 15 })
    assert.deepEqual(record.nodes.find(node => node.nodeId === 'sub/add')?.outputs, { result: 15 })
  })

  it('子工作流节点被跳过时，被嵌入工作流的每个节点都被跳过', async () => {
    const controller = await setup()
    const record = await runEnded(host, RunId(controller.start(idOf(await controller.save(JSON.stringify(parent(true)))))))
    assert.equal(record.status, 'completed')
    assert.deepEqual(record.outputs, {})
    assert.deepEqual(
      record.nodes.filter(node => node.nodeId.startsWith('sub')).map(node => [node.nodeId, node.status]),
      [['sub', 'skipped'], ['sub/add', 'skipped'], ['sub/out', 'skipped']],
    )
  })

  it('不存在的、成环的嵌入照样保存，运行开始时失败；被嵌入的工作流不能改名', async () => {
    const controller = await setup()
    const broken = idOf(await controller.save(JSON.stringify(workflow({ sub: embed('nope') }, [], { name: 'broken' }))))
    assert.throws(() => controller.start(broken), /工作流 nope 不存在/)
    const embedder = idOf(await controller.save(JSON.stringify(parent(false))))
    await controller.update('add-offset', JSON.stringify({ ...ADD_OFFSET, nodes: [...ADD_OFFSET.nodes, { id: NodeId('back'), ...embed('parent') }] }))
    assert.throws(() => controller.start(embedder), /子工作流嵌入成环/)
    await controller.update('add-offset', JSON.stringify(ADD_OFFSET))
    await assert.rejects(controller.update('add-offset', JSON.stringify({ ...ADD_OFFSET, name: 'renamed' })), /被 "parent" 作为子工作流嵌入，不能改名/)
  })
})
