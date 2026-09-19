/**
 * 拓扑排序单元测试。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { topologicalSort } from '../src/engine-provider.ts'
import type { DagWorkflowDefinition } from '../src/types.ts'
import { NodeId, EdgeId } from '../src/types.ts'

function makeWorkflow(edges: Array<[string, string]>): DagWorkflowDefinition {
  const nodeIds = [...new Set(edges.flat())]
  return {
    name: 'test',
    nodes: nodeIds.map(id => ({
      id: NodeId(id),
      type: 'input',
      config: {},
      inputs: [{ name: 'input', type: 'any' }],
      outputs: [{ name: 'output', type: 'any' }],
    })),
    edges: edges.map(([s, t], i) => ({
      id: EdgeId(`e${i}`),
      source: NodeId(s),
      target: NodeId(t),
    })),
  }
}

describe('topologicalSort', () => {
  it('应该对线性 DAG 正确排序', () => {
    const wf = makeWorkflow([['a', 'b'], ['b', 'c']])
    const levels = topologicalSort(wf)
    const order = levels.flatMap(l => l.map(n => n.id))
    // a 必须在 b 之前，b 必须在 c 之前
    assert.ok(order.indexOf(NodeId('a')) < order.indexOf(NodeId('b')))
    assert.ok(order.indexOf(NodeId('b')) < order.indexOf(NodeId('c')))
  })

  it('应该对扇出 DAG（一个输入多个下游）正确排序', () => {
    const wf = makeWorkflow([['a', 'b'], ['a', 'c']])
    const levels = topologicalSort(wf)
    assert.equal(levels.length, 2)
    assert.equal(levels[0]!.length, 1) // a
    assert.equal(levels[0]![0]!.id, NodeId('a'))
    assert.equal(levels[1]!.length, 2) // b, c 同级
  })

  it('应该检测环并抛出', () => {
    const wf = makeWorkflow([['a', 'b'], ['b', 'c'], ['c', 'a']])
    assert.throws(() => topologicalSort(wf), /包含环/)
  })

  it('空工作流应返回空列表', () => {
    const wf: DagWorkflowDefinition = { name: 'empty', nodes: [], edges: [] }
    const levels = topologicalSort(wf)
    assert.equal(levels.length, 0)
  })

  it('隔离节点应在第一层', () => {
    const wf: DagWorkflowDefinition = {
      name: 'isolated',
      nodes: [
        { id: NodeId('a'), type: 'input', config: {} },
      ],
      edges: [],
    }
    const levels = topologicalSort(wf)
    assert.equal(levels.length, 1)
    assert.equal(levels[0]!.length, 1)
  })
})