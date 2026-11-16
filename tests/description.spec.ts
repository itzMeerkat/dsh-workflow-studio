/**
 * 伪代码描述单元测试：节点按执行顺序写成调用，分支写成 if/else，子工作流写成对它嵌入的工作流的调用。
 */

import { describe,it } from 'node:test'
import assert from 'node:assert/strict'
import { describeWorkflow } from '../src/shared/description.ts'
import { irOf,workflow } from './graph-fixtures.ts'

describe('工作流写成伪代码描述', () => {
  it('节点写成调用，实参写出来源，决策节点的两侧写成 if/else，同名节点退回节点 ID', () => {
    const branching = workflow(
      { cond: 'flag', b: 'branch', yes: 'value', no: 'value', m: 'merge', out: 'sink' },
      ['cond>b:condition', 'b.true>yes', 'b.false>no', 'yes.then>m', 'no.then>m', 'yes>m:input1', 'no>m:input2', 'm>out'],
    )
    assert.equal(describeWorkflow(irOf(branching)), [
      'workflow test():',
      '  flag = flag()',
      '  branch(condition: flag)',
      '  if branch.true:',
      '    yes = value()',
      '  else:',
      '    no = value()',
      '  merge = merge(input1: yes, input2: no)',
      '  sink(input: merge)',
      '',
    ].join('\n'))
  })
})
