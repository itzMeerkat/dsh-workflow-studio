/**
 * Canvas graph conversion and connection rule tests.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { connectionError, flowEdges, flowNodes, handleId, toDefinition } from '../src/client/graph-model.ts'
import { EXEC_RUN_PIN, EXEC_THEN_PIN } from '../src/shared/graph.ts'
import { indexNodeTypes } from '../src/shared/analysis.ts'
import { nodeType, workflow } from './graph-fixtures.ts'
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

  it('writes default ports and canvas positions back to the definition', () => {
    const definition = toDefinition(DEFINITION, nodes, edges)
    assert.deepEqual(definition.edges, [{ id: 'e0', kind: 'data', source: 'a', target: 'b', sourcePort: 'output', targetPort: 'input' }])
    assert.deepEqual(definition.nodes.map(node => node.position), [{ x: 1, y: 2 }, { x: 320, y: 80 }, { x: 560, y: 80 }])
  })

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

  const EXEC_DEFINITION = workflowDefinitionSchema.parse(workflow(
    { a: 'num', b: 'num', c: 'num' },
    ['a.then>b'],
  ))

  it('round-trips an execution edge through the canvas', () => {
    const execNodes = flowNodes(EXEC_DEFINITION, CATALOG, new Map(), new Map())
    const execEdges = flowEdges(EXEC_DEFINITION)
    assert.deepEqual(
      execEdges.map(edge => [edge.sourceHandle, edge.targetHandle]),
      [[handleId({ kind: 'exec', name: EXEC_THEN_PIN }), handleId({ kind: 'exec', name: EXEC_RUN_PIN })]],
    )
    assert.deepEqual(toDefinition(EXEC_DEFINITION, execNodes, execEdges).edges, [{
      id: 'e0',
      kind: 'exec',
      source: 'a',
      target: 'b',
      sourcePort: EXEC_THEN_PIN,
      targetPort: EXEC_RUN_PIN,
    }])
  })

  it('keeps a data port whose name looks like an execution pin on the data graph', () => {
    const catalog = new Map(CATALOG)
    catalog.set('odd', {
      type: 'odd', label: 'Odd', description: '', sourcePlugin: 'test', execKind: 'plain', kinds: ['run'] as const, execOutputs: ['then'], controls: [],
      inputs: [{ name: 'exec:run', type: 'number' }],
      outputs: [{ name: 'exec:then', type: 'number' }],
    })
    const definition = workflowDefinitionSchema.parse({
      name: 'graph',
      kind: 'run' as const,
      nodes: [{ id: 'a', type: 'odd', config: {} }, { id: 'b', type: 'odd', config: {} }],
      edges: [{ id: 'e', kind: 'data', source: 'a', sourcePort: 'exec:then', target: 'b', targetPort: 'exec:run' }],
    })
    const oddNodes = flowNodes(definition, catalog, new Map(), new Map())
    const oddEdges = flowEdges(definition)

    // Both handle kinds are prefixed, so the port name is carried verbatim rather than parsed as a pin.
    assert.deepEqual(toDefinition(definition, oddNodes, oddEdges).edges, [{
      id: 'e',
      kind: 'data',
      source: 'a',
      target: 'b',
      sourcePort: 'exec:then',
      targetPort: 'exec:run',
    }])
  })

  it('connects a branch node\'s declared pins to another node\'s run pin', () => {
    const definition = workflowDefinitionSchema.parse({
      name: 'graph',
      kind: 'run' as const,
      nodes: [
        { id: 'fork', type: 'fork', config: {} },
        { id: 'b', type: 'num', config: {} },
      ],
      edges: [],
    })
    const forkNodes = flowNodes(definition, CATALOG, new Map(), new Map())
    const link = (sourceHandle: string) =>
      ({ source: 'fork', target: 'b', sourceHandle, targetHandle: handleId({ kind: 'exec', name: EXEC_RUN_PIN }) })

    assert.equal(connectionError(link(handleId({ kind: 'exec', name: 'true' })), forkNodes, []), undefined)
    assert.equal(connectionError(link(handleId({ kind: 'exec', name: 'false' })), forkNodes, []), undefined)
    // `then` is not among the pins this node declares, so it is not one of its handles.
    assert.equal(connectionError(link(handleId({ kind: 'exec', name: EXEC_THEN_PIN })), forkNodes, []), 'notice.connectPorts')

    const existing = flowEdges(workflowDefinitionSchema.parse({
      ...definition,
      edges: [{ id: 'x', kind: 'exec', source: 'fork', sourcePort: 'true', target: 'b' }],
    }))
    assert.equal(connectionError(link(handleId({ kind: 'exec', name: 'true' })), forkNodes, existing), 'notice.duplicateExecEdge')
    // A second edge from the other pin into the same run pin is still allowed.
    assert.equal(connectionError(link(handleId({ kind: 'exec', name: 'false' })), forkNodes, existing), undefined)
  })

  it('pairs execution pins only with execution pins, and never occupies one', () => {
    const execNodes = flowNodes(EXEC_DEFINITION, CATALOG, new Map(), new Map())
    const execEdges = flowEdges(EXEC_DEFINITION)
    const link = (sourceHandle: string, targetHandle: string) =>
      ({ source: 'a', target: 'b', sourceHandle, targetHandle })

    assert.equal(
      connectionError(
        link(handleId({ kind: 'exec', name: EXEC_THEN_PIN }), handleId({ kind: 'data', name: 'input' })),
        execNodes,
        execEdges,
      ),
      'notice.mixedEdgeKinds',
    )
    assert.equal(
      connectionError(
        link(handleId({ kind: 'data', name: 'output' }), handleId({ kind: 'exec', name: EXEC_RUN_PIN })),
        execNodes,
        execEdges,
      ),
      'notice.mixedEdgeKinds',
    )
    assert.equal(
      connectionError(link(handleId({ kind: 'exec', name: EXEC_RUN_PIN }), handleId({ kind: 'exec', name: EXEC_THEN_PIN })), execNodes, execEdges),
      'notice.connectPorts',
    )
    // A run pin joins every edge that reaches it, where a data input would be occupied.
    assert.equal(
      connectionError(
        { source: 'c', target: 'b', sourceHandle: handleId({ kind: 'exec', name: EXEC_THEN_PIN }), targetHandle: handleId({ kind: 'exec', name: EXEC_RUN_PIN }) },
        execNodes,
        execEdges,
      ),
      undefined,
    )
    // Repeating the edge that already joins these two pins is not.
    assert.equal(
      connectionError(link(handleId({ kind: 'exec', name: EXEC_THEN_PIN }), handleId({ kind: 'exec', name: EXEC_RUN_PIN })), execNodes, execEdges),
      'notice.duplicateExecEdge',
    )
  })
})
