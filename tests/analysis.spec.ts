/**
 * 整图静态分析单元测试：条件引脚 guard 与数据可达性诊断。
 */

import { describe,it } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeWorkflow } from '../src/shared/analysis.ts'
import type { WorkflowDiagnostic } from '../src/shared/analysis.ts'
import { EdgeId,NodeId } from '../src/shared/types.ts'
import type { DagWorkflowDefinition } from '../src/shared/types.ts'
import { CATALOG,workflow } from './graph-fixtures.ts'

function codes(definition: DagWorkflowDefinition): WorkflowDiagnostic[] {
  return [...analyzeWorkflow(definition, CATALOG).diagnostics]
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
})
