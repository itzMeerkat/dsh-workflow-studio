/**
 * Browser workflow model parsing tests.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ZodError } from 'zod'
import {
  appendEditorNode,
  createExecutionPlan,
  filterNodeTypes,
  filterWorkflows,
  formatEditorDefinition,
  nextWorkflowName,
  parseEditorDefinition,
  reduceExecutionDependencies,
} from '../src/client/model.ts'
import {
  importedWorkflowName,
  parseImportedWorkflow,
  workflowFileName,
} from '../src/client/transfer.ts'
import { WorkflowId, type NodeTypeSummary } from '../src/shared/types.ts'
import { workflowDefinitionSchema } from '../src/shared/workflow-schema.ts'

describe('workflow editor model', () => {
  it('round-trips node positions and explicit ports', () => {
    const source = JSON.stringify({
      name: 'visual',
      nodes: [{
        id: 'node',
        type: 'input',
        config: { defaultValue: 1 },
        position: { x: 12, y: 34 },
        outputs: [{
          name: 'value',
          type: 'number',
          required: false,
          display: 'value',
        }],
      }],
      edges: [],
    })

    const definition = parseEditorDefinition(source)
    assert.deepEqual(definition.nodes[0]?.position, { x: 12, y: 34 })
    assert.equal(
      parseEditorDefinition(formatEditorDefinition(definition)).nodes[0]?.outputs?.[0]?.name,
      'value',
    )
    assert.deepEqual(definition.nodes[0]?.outputs?.[0], {
      name: 'value',
      type: 'number',
      required: false,
      display: 'value',
    })
  })

  it('rejects malformed visual metadata', () => {
    assert.throws(
      () => parseEditorDefinition(JSON.stringify({
        name: 'invalid',
        nodes: [{ id: 'node', type: 'input', config: {}, position: { x: 'left', y: 0 } }],
        edges: [],
      })),
      (error: unknown) => {
        assert.ok(error instanceof ZodError)
        assert.deepEqual(error.issues[0]?.path, ['nodes', 0, 'position', 'x'])
        return true
      },
    )
  })

  it('filters node types by metadata and source plugin', () => {
    const nodes: NodeTypeSummary[] = [
      {
        type: 'send-email',
        label: 'Send email',
        description: 'Deliver one message',
        sourcePlugin: 'dsh-mail-workflow',
        execOutputs: ['then'],
        inputs: [],
        outputs: [],
        controls: [],
      },
      {
        type: 'lookup-user',
        label: 'Lookup user',
        description: 'Resolve one account',
        sourcePlugin: 'dsh-directory-workflow',
        execOutputs: ['then'],
        inputs: [],
        outputs: [],
        controls: [],
      },
    ]

    assert.deepEqual(filterNodeTypes(nodes, 'MAIL').map(node => node.type), ['send-email'])
    assert.deepEqual(filterNodeTypes(nodes, 'account').map(node => node.type), ['lookup-user'])
    assert.equal(filterNodeTypes(nodes, '').length, 2)
  })

  it('filters workflows by name', () => {
    const workflows = [
      { id: WorkflowId('first'), name: 'Deploy Release', definition: '{}' },
      { id: WorkflowId('second'), name: 'Review Changes', definition: '{}' },
    ]

    assert.deepEqual(filterWorkflows(workflows, 'release').map(row => row.id), ['first'])
    assert.deepEqual(filterWorkflows(workflows, '  REVIEW ').map(row => row.id), ['second'])
    assert.equal(filterWorkflows(workflows, '').length, 2)
  })

  it('allocates the first available default workflow name', () => {
    assert.equal(nextWorkflowName([{ name: 'workflow-1' }, { name: 'workflow-3' }]), 'workflow-2')
  })

  it('appends one positioned node per explicit catalog selection', () => {
    const nodeType: NodeTypeSummary = {
      type: 'worker',
      label: 'Worker',
      description: 'Runs work',
      sourcePlugin: 'test',
      execOutputs: ['then'],
      inputs: [],
      outputs: [],
      controls: [{
        name: 'enabled',
        label: 'Enabled',
        kind: 'boolean',
        defaultValue: true,
      }],
    }
    const initial = { name: 'editor', nodes: [], edges: [] }
    const first = appendEditorNode(initial, nodeType)
    const second = appendEditorNode(first, nodeType)

    assert.deepEqual(initial.nodes, [])
    assert.deepEqual(first.nodes, [{
      id: 'worker-1',
      type: 'worker',
      config: { enabled: true },
      position: { x: 80, y: 80 },
    }])
    assert.equal(second.nodes.length, 2)
    assert.equal(second.nodes[1]?.id, 'worker-2')
    assert.notDeepEqual(second.nodes[1]?.position, first.nodes[0]?.position)
  })

  it('groups nodes into scheduler-compatible parallel stages', () => {
    const plan = createExecutionPlan(workflowDefinitionSchema.parse({
      name: 'branch',
      nodes: [
        { id: 'left', type: 'input', config: {} },
        { id: 'right', type: 'input', config: {} },
        { id: 'branch', type: 'branch', config: {} },
        { id: 'accepted', type: 'output', config: {} },
        { id: 'rejected', type: 'output', config: {} },
      ],
      edges: [
        { id: 'left-branch', kind: 'data', source: 'left', target: 'branch', targetPort: 'left' },
        { id: 'left-accepted', kind: 'data', source: 'left', target: 'accepted', targetPort: 'value' },
        { id: 'right-branch', kind: 'data', source: 'right', target: 'branch', targetPort: 'right' },
        { id: 'accepted-data', kind: 'data', source: 'branch', sourcePort: 'true', target: 'accepted', targetPort: 'value' },
        { id: 'accepted-exec', kind: 'exec', source: 'branch', sourcePort: 'true', target: 'accepted' },
        { id: 'rejected-exec', kind: 'exec', source: 'branch', sourcePort: 'false', target: 'rejected' },
      ],
    }))

    assert.deepEqual(
      plan.stages.map(stage => stage.nodes.map(item => item.node.id)),
      [['left', 'right'], ['branch'], ['accepted', 'rejected']],
    )
    assert.deepEqual(
      plan.dependencies.map(dependency => [
        dependency.source.id,
        dependency.target.id,
        dependency.execSourcePin,
      ]),
      [
        ['left', 'branch', undefined],
        ['left', 'accepted', undefined],
        ['right', 'branch', undefined],
        ['branch', 'accepted', 'true'],
        ['branch', 'rejected', 'false'],
      ],
    )
    assert.deepEqual(
      reduceExecutionDependencies(plan).map(dependency => [
        dependency.source.id,
        dependency.target.id,
        dependency.execSourcePin,
      ]),
      [
        ['left', 'branch', undefined],
        ['right', 'branch', undefined],
        ['branch', 'accepted', 'true'],
        ['branch', 'rejected', 'false'],
      ],
    )
    assert.equal(plan.stages[2]?.nodes[0]?.dependencies.length, 2)
    assert.deepEqual(plan.cyclicNodeIds, [])
  })

  it('reports nodes that cannot be assigned to an execution stage', () => {
    const plan = createExecutionPlan(workflowDefinitionSchema.parse({
      name: 'cycle',
      nodes: [
        { id: 'a', type: 'input', config: {} },
        { id: 'b', type: 'output', config: {} },
      ],
      edges: [
        { id: 'a-b', kind: 'data', source: 'a', target: 'b' },
        { id: 'b-a', kind: 'data', source: 'b', target: 'a' },
      ],
    }))

    assert.deepEqual(plan.stages, [])
    assert.deepEqual(plan.cyclicNodeIds, ['a', 'b'])
    assert.deepEqual(reduceExecutionDependencies(plan), plan.dependencies)
  })

  it('keeps an execution dependency a data path already implies', () => {
    const plan = createExecutionPlan(workflowDefinitionSchema.parse({
      name: 'redundant-exec',
      nodes: [
        { id: 'a', type: 'input', config: {} },
        { id: 'b', type: 'output', config: {} },
        { id: 'c', type: 'output', config: {} },
      ],
      edges: [
        { id: 'a-b', kind: 'data', source: 'a', target: 'b' },
        { id: 'b-c', kind: 'data', source: 'b', target: 'c' },
        { id: 'a-c-data', kind: 'data', source: 'a', target: 'c' },
      ],
    }))
    // The a -> c data dependency is implied by a -> b -> c, so reduction drops it.
    assert.deepEqual(
      reduceExecutionDependencies(plan).map(item => [item.source.id, item.target.id]),
      [['a', 'b'], ['b', 'c']],
    )

    const execPlan = createExecutionPlan(workflowDefinitionSchema.parse({
      name: 'redundant-exec',
      nodes: [
        { id: 'a', type: 'input', config: {} },
        { id: 'b', type: 'output', config: {} },
        { id: 'c', type: 'output', config: {} },
      ],
      edges: [
        { id: 'a-b', kind: 'data', source: 'a', target: 'b' },
        { id: 'b-c', kind: 'data', source: 'b', target: 'c' },
        { id: 'a-c-exec', kind: 'exec', source: 'a', target: 'c' },
      ],
    }))
    assert.deepEqual(
      reduceExecutionDependencies(execPlan).map(item => [item.source.id, item.target.id]),
      [['a', 'b'], ['b', 'c'], ['a', 'c']],
    )
  })
})

describe('workflow import and export', () => {
  const definition = { name: 'Daily Report v2', nodes: [], edges: [] }

  it('names the exported file after the workflow, like its record file', () => {
    assert.equal(workflowFileName(definition), 'daily-report-v2.workflow.json')
    assert.equal(workflowFileName({ ...definition, name: '\u6570\u636e\u5904\u7406' }), 'workflow.workflow.json')
  })

  it('imports an exported definition and a record document copied from storage', () => {
    const exported = formatEditorDefinition(definition)

    assert.deepEqual(parseImportedWorkflow(exported), definition)
    assert.deepEqual(parseImportedWorkflow(JSON.stringify({ version: 2, record: definition })), definition)
    assert.throws(() => parseImportedWorkflow('{'), SyntaxError)
    assert.throws(() => parseImportedWorkflow(JSON.stringify({ name: 'no-graph' })), ZodError)
  })

  it('renames an imported workflow onto the first free name, so saving never replaces one', () => {
    const saved = [{ name: 'Daily Report v2' }, { name: 'Daily Report v2 (2)' }]

    assert.equal(importedWorkflowName('Daily Report v2', saved), 'Daily Report v2 (3)')
    assert.equal(importedWorkflowName('Weekly Report', saved), 'Weekly Report')
  })
})
