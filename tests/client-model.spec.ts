/**
 * Browser workflow model parsing tests.
 */

import assert from 'node:assert/strict'
import { describe,it } from 'node:test'
import { ZodError } from 'zod'
import {
formatEditorDefinition
} from '../src/client/model.ts'
import {
withWorkflowPorts
} from '../src/client/workflow-ports.ts'
import { workflow } from './graph-fixtures.ts'
import { WORKFLOW_INPUT_TYPE,WORKFLOW_OUTPUT_TYPE,workflowInputPorts } from '../src/shared/workflow-boundary.ts'
import {
parseImportedWorkflow
} from '../src/client/transfer.ts'

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
