/**
 * Canvas graph conversion and connection rule tests.
 */

import assert from 'node:assert/strict'
import { describe,it } from 'node:test'
import { connectionError,editNode,flowEdges,flowNodes,handleId } from '../src/client/graph-model.ts'
import { indexNodeTypes } from '../src/shared/analysis.ts'
import { NODE_TYPES,nodeType,workflow } from './graph-fixtures.ts'
import { SUBWORKFLOW_FIELD,SUBWORKFLOW_TYPE } from '../src/shared/subworkflow.ts'
import { NodeId,WorkflowId } from '../src/shared/types.ts'
import { WORKFLOW_INPUT_TYPE } from '../src/shared/workflow-boundary.ts'
import { workflowDefinitionSchema } from '../src/shared/workflow-schema.ts'

const CATALOG = indexNodeTypes([
  nodeType('num', {
    inputs: [{ name: 'input', type: 'number' }],
    outputs: [{ name: 'output', type: 'number' }],
  }),
  nodeType('text', {
    inputs: [{ name: 'input', type: 'string' }],
    outputs: [{ name: 'output', type: 'string' }],
  }),
  nodeType('fork', {
    execKind: 'decision',
    execOutputs: ['true', 'false'],
    inputs: [{ name: 'condition', type: 'boolean' }],
    outputs: [],
  }),
])

const DEFINITION = workflowDefinitionSchema.parse(workflow(
  { a: { type: 'num', position: { x: 1, y: 2 } }, b: 'num', c: 'text' },
  ['a>b'],
))

describe('canvas graph model', () => {
  const nodes = flowNodes(DEFINITION, CATALOG, new Map(), new Map())
  const edges = flowEdges(DEFINITION)

  it('rejects connections to unknown ports, incompatible types, and occupied inputs', () => {
    const connect = (source: string, target: string, targetPort: string | null = 'input') =>
      ({
        source,
        target,
        sourceHandle: handleId({ kind: 'data', name: 'output' }),
        targetHandle: targetPort === null ? null : handleId({ kind: 'data', name: targetPort }),
      })
    assert.equal(connectionError(connect('a', 'b', null), nodes, edges), 'notice.connectPorts')
    assert.equal(connectionError(connect('a', 'b', 'missing'), nodes, edges), 'notice.connectPorts')
    assert.equal(connectionError(connect('a', 'c'), nodes, edges), 'notice.incompatiblePorts')
    assert.equal(connectionError(connect('c', 'b'), nodes, edges), 'notice.incompatiblePorts')
    assert.equal(connectionError(connect('a', 'b'), nodes, edges), 'notice.inputConnected')
    assert.equal(connectionError(connect('a', 'b'), nodes, edges, 'e0'), undefined)
  })

  it('editing one node also gives every other subworkflow node the ports of the workflow it embeds', () => {
    const child = workflow({ in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'x', type: 'number' }] } }, [], { name: 'child' })
    const embed = (inputs: { name: string; type: string }[]) =>
      ({ type: SUBWORKFLOW_TYPE, config: { [SUBWORKFLOW_FIELD]: 'child' }, inputs, outputs: [] })
    // `b` was saved while the child still declared `old`, so its edge sits on a port the child no longer has.
    const parent = workflow({ v: 'value', a: embed([{ name: 'x', type: 'number' }]), b: embed([{ name: 'old', type: 'number' }]) },
      ['v>a:x', 'v>b:old'])
    const catalog = indexNodeTypes([...NODE_TYPES, nodeType(SUBWORKFLOW_TYPE)])
    const graph = { nodes: flowNodes(parent, catalog, new Map(), new Map()), edges: flowEdges(parent) }

    const next = editNode(parent, graph, 'a', node => ({ ...node, label: 'first' }), id => id === WorkflowId('child') ? child : undefined)
    const byId = new Map(next.nodes.map(node => [node.id, node.data.definition]))
    assert.equal(byId.get(NodeId('a'))?.label, 'first')
    assert.deepEqual(byId.get(NodeId('b'))?.inputs, [{ name: 'x', type: 'number' }])
    assert.deepEqual(next.edges.map(edge => edge.id), ['e0'])
    assert.equal(next.nodes.find(node => node.id === 'v'), graph.nodes.find(node => node.id === 'v'))
  })
})
