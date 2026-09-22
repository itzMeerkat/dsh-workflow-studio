/**
 * 拓扑排序单元测试。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { workflow } from './graph-fixtures.ts'
import { topologicalSort } from '../src/validation.ts'
import type { DagWorkflowDefinition } from '../src/shared/types.ts'

/** `a>b` 写法的数据边构成的图；节点类型都是通用的 `value`。 */
function graph(...wires: readonly string[]): DagWorkflowDefinition {
  const ids = [...new Set(wires.flatMap(wire => wire.split('>')))]
  return workflow(Object.fromEntries(ids.map(id => [id, 'value'])), wires)
}

function levels(definition: DagWorkflowDefinition): string[][] {
  return topologicalSort(definition).map(level => level.map(node => node.id))
}

describe('topologicalSort', () => {
  it('按数据依赖分层，扇出节点同层，隔离节点在第一层', () => {
    assert.deepEqual(levels(graph('a>b', 'b>c')), [['a'], ['b'], ['c']])
    assert.deepEqual(levels(graph('a>b', 'a>c')), [['a'], ['b', 'c']])
    assert.deepEqual(levels(workflow({ a: 'value' }, [])), [['a']])
    assert.deepEqual(levels(workflow({}, [])), [])
  })

  it('构成环的数据边被拒绝', () => {
    assert.throws(() => topologicalSort(graph('a>b', 'b>c', 'c>a')), /包含环/)
  })
})
