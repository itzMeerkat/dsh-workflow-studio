/**
 * 中间表示单元测试。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IrBlock } from '../src/shared/ir.ts'
import { NodeId } from '../src/shared/types.ts'
import { WORKFLOW_INPUT_TYPE } from '../src/shared/workflow-boundary.ts'
import { irOf, workflow } from './graph-fixtures.ts'

/** 块树的简写：调用写类型名，guard 写 `守卫节点.引脚` 及其内容。 */
function shape(block: IrBlock): unknown[] {
  return block.map((item) => {
    if (item.kind === 'call') return item.type
    if (item.kind === 'outputs') return 'outputs'
    return Object.fromEntries(item.arms.map(arm => [`${item.gate.node}.${arm.pin}`, shape(arm.body)]))
  })
}

describe('中间表示', () => {
  it('决策节点的两侧写成同一个 guard 的两个 arm，实参记录每个值的来源', () => {
    const ir = irOf(workflow(
      { cond: 'flag', b: 'branch', yes: 'value', no: 'value', m: 'merge' },
      ['cond>b:condition', 'b.true>yes', 'b.false>no', 'yes.then>m', 'no.then>m', 'yes>m:input1', 'no>m:input2'],
    ))
    assert.deepEqual(shape(ir.body), ['flag', 'branch', { 'b.true': ['value'], 'b.false': ['value'] }, 'merge'])
    assert.deepEqual(ir.body[3]!.kind === 'call' ? ir.body[3]!.args : [], [
      { port: 'input1', value: { kind: 'output', node: NodeId('yes'), port: 'output' } },
      { port: 'input2', value: { kind: 'output', node: NodeId('no'), port: 'output' } },
    ])
  })

  it('同一分支的节点依赖分支之后的节点时，分支拆成两段，写出顺序始终不早于上游', () => {
    const ir = irOf(workflow(
      { cond: 'flag', b: 'branch', yes: 'value', no: 'value', m: 'merge', after: 'double' },
      [
        'cond>b:condition', 'b.true>yes', 'b.false>no', 'yes.then>m', 'no.then>m',
        'yes>m:input1', 'no>m:input2', 'm>after', 'b.true>after',
      ],
    ))
    assert.deepEqual(shape(ir.body), [
      'flag', 'branch', { 'b.true': ['value'], 'b.false': ['value'] }, 'merge', { 'b.true': ['double'] },
    ])
  })

  it('嵌套分支逐层成块，回到外层后继续写外层', () => {
    const ir = irOf(workflow(
      { cond: 'flag', b: 'branch', inner: 'flag', c: 'branch', deep: 'value', shallow: 'value', tail: 'value' },
      ['cond>b:condition', 'b.true>c', 'inner>c:condition', 'c.true>deep', 'b.false>shallow', 'deep.then>tail', 'b.true>tail'],
    ))
    assert.deepEqual(shape(ir.body), [
      'flag', 'flag', 'branch',
      { 'b.true': ['branch', { 'c.true': ['value', 'value'] }], 'b.false': ['value'] },
    ])
  })

  it('工作流输入是签名，引用它的实参不提节点', () => {
    const ir = irOf(workflow(
      { in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'amount', type: 'number' }] }, calc: 'double' },
      ['in:amount>calc'],
    ))
    assert.deepEqual(ir.inputs, [{ name: 'amount', type: 'number' }])
    assert.deepEqual(shape(ir.body), ['double'])
    assert.deepEqual(ir.body[0]!.kind === 'call' ? ir.body[0]!.args : [], [
      { port: 'input', value: { kind: 'input', port: 'amount' } },
    ])
  })
})
