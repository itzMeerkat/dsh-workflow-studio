/**
 * Canvas graph conversion and connection rule tests.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { connectionError, flowEdges, flowNodes, toDefinition } from '../src/client/graph-model.ts'
import type { NodeTypeSummary } from '../src/shared/types.ts'
import { workflowDefinitionSchema } from '../src/shared/workflow-schema.ts'

const CATALOG = new Map<string, NodeTypeSummary>([
  ['num', {
    type: 'num', label: 'Number', description: '', sourcePlugin: 'test', controls: [],
    inputs: [{ name: 'input', type: 'number' }],
    outputs: [{ name: 'output', type: 'number' }],
  }],
  ['text', {
    type: 'text', label: 'Text', description: '', sourcePlugin: 'test', controls: [],
    inputs: [{ name: 'input', type: 'string' }],
    outputs: [{ name: 'output', type: 'string' }],
  }],
])

const DEFINITION = workflowDefinitionSchema.parse({
  name: 'graph',
  nodes: [
    { id: 'a', type: 'num', config: {}, position: { x: 1, y: 2 } },
    { id: 'b', type: 'num', config: {} },
    { id: 'c', type: 'text', config: {} },
  ],
  edges: [{ id: 'e1', source: 'a', target: 'b' }],
})

describe('canvas graph model', () => {
  const nodes = flowNodes(DEFINITION, CATALOG, new Map())
  const edges = flowEdges(DEFINITION)

  it('writes default ports and canvas positions back to the definition', () => {
    const definition = toDefinition(DEFINITION, nodes, edges)
    assert.deepEqual(definition.edges, [{ id: 'e1', source: 'a', target: 'b', sourcePort: 'output', targetPort: 'input' }])
    assert.deepEqual(definition.nodes.map(node => node.position), [{ x: 1, y: 2 }, { x: 320, y: 80 }, { x: 560, y: 80 }])
  })

  it('rejects connections to unknown ports, incompatible types, and occupied inputs', () => {
    const connect = (source: string, target: string, targetHandle: string | null = 'input') =>
      ({ source, target, sourceHandle: 'output', targetHandle })
    assert.equal(connectionError(connect('a', 'b', null), nodes, edges), 'notice.connectPorts')
    assert.equal(connectionError(connect('a', 'b', 'missing'), nodes, edges), 'notice.connectPorts')
    assert.equal(connectionError(connect('a', 'c'), nodes, edges), 'notice.incompatiblePorts')
    assert.equal(connectionError(connect('c', 'b'), nodes, edges), 'notice.incompatiblePorts')
    assert.equal(connectionError(connect('a', 'b'), nodes, edges), 'notice.inputConnected')
    assert.equal(connectionError(connect('a', 'b'), nodes, edges, 'e1'), undefined)
  })
})
