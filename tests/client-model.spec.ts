/**
 * Browser workflow model parsing tests.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ZodError } from 'zod'
import { copyNodes, formatEditorDefinition, pasteNodes } from '../src/client/model.ts'
import { withWorkflowPorts } from '../src/client/workflow-ports.ts'
import { workflow } from './graph-fixtures.ts'
import { WORKFLOW_INPUT_TYPE, WORKFLOW_OUTPUT_TYPE, workflowInputPorts } from '../src/shared/workflow-boundary.ts'
import { parseImportedWorkflow } from '../src/client/transfer.ts'

describe('workflow import and export', () => {
  const definition = { name: 'Daily Report v2', nodes: [], edges: [] }

  it('imports an exported definition and a record document copied from storage', () => {
    const exported = formatEditorDefinition(definition)

    assert.deepEqual(parseImportedWorkflow(exported), definition)
    assert.deepEqual(parseImportedWorkflow(JSON.stringify({ version: 2, record: definition })), definition)
    assert.throws(() => parseImportedWorkflow('{'), SyntaxError)
    assert.throws(() => parseImportedWorkflow(JSON.stringify({ name: 'no-graph' })), ZodError)
  })
})

describe('workflow port edits move their edges', () => {
  const declared = workflow({
    'workflow-input': { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'left', type: 'number' }] },
    add: 'double',
    'workflow-output': { type: WORKFLOW_OUTPUT_TYPE, inputs: [{ name: 'total', type: 'number' }] },
  }, ['workflow-input:left>add:input', 'add:output>workflow-output:total', 'add:output>add:input'])

  it('改名把边带到新端口，两侧各自只动自己的一端；删除端口带走它的边', () => {
    const renamed = withWorkflowPorts(declared, 'inputs', [{ name: 'amount', type: 'number' }], { kind: 'renamed', from: 'left', to: 'amount' })
    assert.deepEqual(workflowInputPorts(renamed), [{ name: 'amount', type: 'number' }])
    assert.equal(renamed.edges[0]?.sourcePort, 'amount')
    assert.deepEqual(renamed.edges.slice(1), declared.edges.slice(1))

    const removed = withWorkflowPorts(declared, 'outputs', [], { kind: 'removed', name: 'total' })
    assert.deepEqual(removed.edges.map(edge => edge.id), ['e0', 'e2'])
  })
})

describe('copy and paste', () => {
  it('copies the selected nodes with the edges between them, leaves boundary nodes, and pastes them under fresh IDs', () => {
    const source = workflow({
      in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'x', type: 'number' }] },
      a: { type: 'value', position: { x: 0, y: 0 } },
      b: { type: 'double', position: { x: 100, y: 0 } },
      c: 'sink',
    }, ['in:x>b', 'a>b', 'b>c'])
    const clip = copyNodes(source, new Set(['in', 'a', 'b']))!
    assert.deepEqual(clip.nodes.map(node => node.id), ['a', 'b'])
    assert.deepEqual(clip.edges.map(edge => edge.id), ['e1'])

    const { definition, ids } = pasteNodes(source, clip, 32)
    assert.deepEqual(ids, ['value-1', 'double-1'])
    assert.deepEqual(definition.nodes.slice(-2).map(node => node.position), [{ x: 32, y: 32 }, { x: 132, y: 32 }])
    const pasted = definition.edges.at(-1)!
    assert.deepEqual([pasted.source, pasted.target], ['value-1', 'double-1'])
    assert.notEqual(pasted.id, 'e1')
    assert.equal(copyNodes(source, new Set(['in'])), undefined)
  })
})
