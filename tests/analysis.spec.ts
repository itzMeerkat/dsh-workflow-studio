/**
 * 整图静态分析单元测试：条件引脚 guard、数据可达性诊断与输出类型推断。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeWorkflow } from '../src/shared/analysis.ts'
import type { WorkflowDiagnostic } from '../src/shared/analysis.ts'
import { EdgeId, NodeId } from '../src/shared/types.ts'
import type { DagNodeDefinition, DagWorkflowDefinition, PortDefinition } from '../src/shared/types.ts'
import { WORKFLOW_OUTPUT_TYPE } from '../src/shared/workflow-boundary.ts'
import { CATALOG, workflow } from './graph-fixtures.ts'

function codes(definition: DagWorkflowDefinition): WorkflowDiagnostic[] {
  return [...analyzeWorkflow(definition, CATALOG).diagnostics]
}

/** 声明输出端口的工作流输出节点。 */
function outputNode(ports: readonly PortDefinition[]): DagNodeDefinition {
  return { id: NodeId('out'), type: WORKFLOW_OUTPUT_TYPE, config: {}, inputs: [...ports] }
}

describe('整图静态分析', () => {
  it('分支内的节点为分支外的必需输入供值时被拒绝', () => {
    const starved = workflow(
      { cond: 'flag', b: 'branch', inner: 'value', outer: 'sink' },
      ['cond>b:condition', 'b.true>inner', 'inner>outer'],
    )
    assert.deepEqual(codes(starved), [{
      code: 'starved-input',
      nodeId: NodeId('outer'),
      edgeId: EdgeId('e2'),
      sourceId: NodeId('inner'),
      port: 'input',
      pin: 'b.true',
    }])
  })

  it('目标依赖同一引脚触发时不再是问题', () => {
    const gated = workflow(
      { cond: 'flag', b: 'branch', inner: 'value', outer: 'sink' },
      ['cond>b:condition', 'b.true>inner', 'inner>outer', 'inner.then>outer'],
    )
    assert.deepEqual(codes(gated), [])
  })

  it('单引脚节点不引入条件，因此长链上的数据边不受影响', () => {
    const chain = workflow({ a: 'value', b: 'sink' }, ['a.then>b', 'a>b'])
    assert.deepEqual(codes(chain), [])
  })

  it('两侧互斥分支汇入 merge 既不重叠也不缺口', () => {
    const balanced = workflow(
      { cond: 'flag', b: 'branch', yes: 'value', no: 'value', m: 'merge', out: 'sink' },
      [
        'cond>b:condition', 'b.true>yes', 'b.false>no',
        'yes.then>m', 'no.then>m', 'yes>m:input1', 'no>m:input2', 'm>out',
      ],
    )
    assert.deepEqual(codes(balanced), [])
  })

  it('嵌套分支只要覆盖每个引脚就仍然恰好送达一个', () => {
    const nested = workflow(
      {
        cond: 'flag', b: 'branch', c: 'branch', flag2: 'flag',
        yes: 'value', no: 'value', other: 'value', m: 'merge',
      },
      [
        'cond>b:condition', 'b.true>c', 'flag2>c:condition', 'c.true>yes', 'c.false>no', 'b.false>other',
        'yes.then>m', 'no.then>m', 'other.then>m',
        'yes>m:input1', 'no>m:input2', 'other>m:input3',
      ],
    )
    nested.nodes[7] = {
      id: NodeId('m'),
      type: 'merge',
      config: {},
      inputs: [1, 2, 3].map(index => ({ name: `input${index}`, type: 'any' as const, required: false })),
    }
    assert.deepEqual(codes(nested), [])
  })

  it('同一引脚下的两个数据源同时送达，而 merge 只接受一个', () => {
    const lopsided = workflow(
      { cond: 'flag', b: 'branch', one: 'value', two: 'value', m: 'merge' },
      [
        'cond>b:condition', 'b.true>one', 'b.true>two',
        'one.then>m', 'two.then>m', 'one>m:input1', 'two>m:input2',
      ],
    )
    assert.deepEqual(codes(lopsided), [
      { code: 'merge-overlap', nodeId: NodeId('m'), sources: [NodeId('one'), NodeId('two')] },
    ])
  })

  it('数据源分属两个互不相关的分支时，既可能同时送达也可能都不送达', () => {
    const unrelated = workflow(
      { cond: 'flag', other: 'flag', b: 'branch', c: 'branch', one: 'value', two: 'value', m: 'merge' },
      [
        'cond>b:condition', 'other>c:condition', 'b.true>one', 'c.true>two',
        'one.then>m', 'two.then>m', 'one>m:input1', 'two>m:input2',
      ],
    )
    assert.deepEqual(codes(unrelated), [
      { code: 'merge-overlap', nodeId: NodeId('m'), sources: [NodeId('one'), NodeId('two')] },
      { code: 'merge-gap', nodeId: NodeId('m') },
    ])
  })

  it('工作流输出端口在未触发的分支下没有值时给出告警', () => {
    const gap = workflow(
      { cond: 'flag', b: 'branch', inner: 'value' },
      ['cond>b:condition', 'b.true>inner', 'inner>out:result'],
    )
    gap.nodes.push(outputNode([{ name: 'result', type: 'number', required: false }]))
    assert.deepEqual(codes(gap), [{
      code: 'output-gap',
      nodeId: NodeId('out'),
      edgeId: EdgeId('e2'),
      sourceId: NodeId('inner'),
      port: 'result',
      pin: 'b.true',
    }])
  })

  it('merge 把两个来源共同的类型送出，与下游端口不符时给出告警', () => {
    const narrowed = workflow(
      { cond: 'flag', b: 'branch', yes: 'value', no: 'value', m: 'merge', out: 'text-sink' },
      [
        'cond>b:condition', 'b.true>yes', 'b.false>no',
        'yes.then>m', 'no.then>m', 'yes>m:input1', 'no>m:input2', 'm>out',
      ],
    )
    assert.deepEqual(codes(narrowed), [{
      code: 'type-mismatch',
      nodeId: NodeId('out'),
      edgeId: EdgeId('e7'),
      port: 'input',
      types: ['number', 'string'],
    }])
  })

  it('来源类型不一致时推断退回 any，不再给出类型告警', () => {
    const mixed = workflow(
      { cond: 'flag', b: 'branch', yes: 'value', no: 'text', m: 'merge', out: 'text-sink' },
      [
        'cond>b:condition', 'b.true>yes', 'b.false>no',
        'yes.then>m', 'no.then>m', 'yes>m:input1', 'no>m:input2', 'm>out',
      ],
    )
    mixed.nodes[3] = { id: NodeId('no'), type: 'value', config: {}, outputs: [{ name: 'output', type: 'string' }] }
    assert.deepEqual(codes(mixed), [])
  })
})

describe('工作流种类', () => {
  it('只汇合执行流的连接点没有值要送达，不给出诊断', () => {
    const controlOnly = workflow(
      { cond: 'flag', b: 'branch', yes: 'value', no: 'value', m: 'merge' },
      ['cond>b:condition', 'b.true>yes', 'b.false>no', 'yes.then>m', 'no.then>m'],
    )
    assert.deepEqual(codes(controlOnly), [])
  })
})
