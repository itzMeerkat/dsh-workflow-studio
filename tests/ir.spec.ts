/**
 * 中间表示单元测试。
 */

import { describe,it } from 'node:test'
import assert from 'node:assert/strict'
import type { IrBlock } from '../src/shared/ir.ts'
import { irOf,workflow } from './graph-fixtures.ts'

/** 块树的简写：调用写类型名，guard 写 `守卫节点.引脚` 及其内容。 */
function shape(block: IrBlock): unknown[] {
  return block.map((item) => {
    if (item.kind === 'call') return item.type
    if (item.kind === 'outputs') return 'outputs'
    return Object.fromEntries(item.arms.map(arm => [`${item.gate.node}.${arm.pin}`, shape(arm.body)]))
  })
}

describe('中间表示', () => {

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
})
