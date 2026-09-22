/**
 * 浏览器侧分析模型单元测试。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeEditorGraph } from '../src/client/analysis-model.ts'
import { EdgeId, NodeId } from '../src/shared/types.ts'
import { NODE_TYPES, workflow } from './graph-fixtures.ts'

describe('浏览器侧分析模型', () => {
  it('诊断按节点分组，并给出同一张图的 IR', () => {
    const starved = workflow(
      { cond: 'flag', b: 'branch', inner: 'value', outer: 'sink' },
      ['cond>b:condition', 'b.true>inner', 'inner>outer'],
    )
    const analysis = analyzeEditorGraph(starved, NODE_TYPES)
    assert.deepEqual(analysis?.diagnostics, [{
      code: 'starved-input',
      nodeId: NodeId('outer'),
      edgeId: EdgeId('e2'),
      sourceId: NodeId('inner'),
      port: 'input',
      pin: 'b.true',
    }])
    assert.deepEqual([...analysis!.byNode.keys()], ['outer'])
    assert.equal(analysis!.ir.body.length, 4)
  })

  it('节点类型不在目录中时不分析', () => {
    const unknown = workflow({ a: 'value', b: 'sink' }, ['a>b'])
    unknown.nodes[1] = { id: NodeId('b'), type: 'not-registered', config: {} }
    assert.equal(analyzeEditorGraph(unknown, NODE_TYPES), undefined)
  })

  it('图中存在环时不分析', () => {
    const cyclic = workflow({ a: 'double', b: 'double' }, ['a>b', 'b>a'])
    assert.equal(analyzeEditorGraph(cyclic, NODE_TYPES), undefined)
  })
})
