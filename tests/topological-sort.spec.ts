/**
 * 拓扑排序单元测试。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { topologicalSort } from '../src/validation.ts'
import type { DagWorkflowDefinition } from '../src/shared/types.ts'
import { NodeId, EdgeId } from '../src/shared/types.ts'

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
      kind: 'data' as const,
      source: NodeId(s),
      target: NodeId(t),
    })),
  }
}

describe('topologicalSort', () => {
  it('按数据依赖分层，扇出节点同层，隔离节点在第一层', () => {
    const chain = topologicalSort(makeWorkflow([['a', 'b'], ['b', 'c']]))
    assert.deepEqual(chain.map(level => level.map(node => node.id)), [['a'], ['b'], ['c']])

    const fanOut = topologicalSort(makeWorkflow([['a', 'b'], ['a', 'c']]))
    assert.deepEqual(fanOut.map(level => level.map(node => node.id)), [['a'], ['b', 'c']])

    const isolated = topologicalSort({
      name: 'isolated',
      nodes: [{ id: NodeId('a'), type: 'input', config: {} }],
      edges: [],
    })
    assert.deepEqual(isolated.map(level => level.map(node => node.id)), [['a']])

    assert.deepEqual(topologicalSort({ name: 'empty', nodes: [], edges: [] }), [])
  })

  it('构成环的数据边被拒绝', () => {
    assert.throws(() => topologicalSort(makeWorkflow([['a', 'b'], ['b', 'c'], ['c', 'a']])), /包含环/)
  })
})
