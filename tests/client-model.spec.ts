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
import { estimateNodeCardHeight, executionLayout } from '../src/client/execution-layout.ts'
import type { WorkflowNodeData } from '../src/client/graph-model.ts'
import {
  appendWorkflowPort,
  formatWorkflowPortDefault,
  parseWorkflowPortDefault,
  removeWorkflowPort,
  setWorkflowPortDefault,
  updateWorkflowPort,
  workflowPortFault,
  workflowResultValues,
  workflowRunDefaults,
  workflowRunInputs,
} from '../src/client/workflow-ports.ts'
import { applyWorkflowPortEdit, flowNodes, toDefinition } from '../src/client/graph-model.ts'
import {
  boundaryPorts, WORKFLOW_INPUT_TYPE, WORKFLOW_OUTPUT_TYPE, withBoundaryPorts,
  workflowInputPorts, workflowOutputPorts,
} from '../src/shared/workflow-boundary.ts'
import {
  importedWorkflowName,
  parseImportedWorkflow,
  workflowFileName,
} from '../src/client/transfer.ts'
import {
  NodeId, RunId, WorkflowId, type NodeRunRecord, type NodeTypeSummary, type PortDefinition,
} from '../src/shared/types.ts'
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

describe('execution stage layout', () => {
  const card = (id: string, ports: readonly PortDefinition[] = []): WorkflowNodeData => ({
    definition: { id: NodeId(id), type: 'demo', config: {} },
    catalog: {
      type: 'demo',
      label: 'Demo',
      description: '',
      sourcePlugin: 'dsh-workflow-demo-node',
      inputs: ports,
      outputs: [],
      execOutputs: ['then'],
      controls: [],
    },
  })

  it('每个阶段一条泳道，卡片按估算高度在泳道内依次堆叠', () => {
    const first = card('a')
    const second = card('b')
    const layout = executionLayout([[first, second], [card('c')]], 'Stage')

    assert.deepEqual(layout.bands.map(band => band.label), ['Stage 1', 'Stage 2'])
    assert.ok(layout.bands[1]!.x >= layout.bands[0]!.x + layout.bands[0]!.width)
    assert.deepEqual(
      layout.cards.map(item => [item.nodeId, item.bandId]),
      [['a', 'stage:1'], ['b', 'stage:1'], ['c', 'stage:2']],
    )
    assert.ok(layout.cards[1]!.y >= layout.cards[0]!.y + estimateNodeCardHeight(first))
    assert.equal(layout.cards[2]!.y, layout.cards[0]!.y)
  })

  it('边界节点按它自己的卡片估算高度，端口行是一排字段而不是一行标签', () => {
    const boundary: WorkflowNodeData = {
      definition: {
        id: NodeId('out'),
        type: WORKFLOW_OUTPUT_TYPE,
        config: {},
        inputs: [{ name: 'verdict', type: 'any', required: false }],
      },
    }
    const plain = card('a', [{ name: 'verdict', type: 'any' }])

    assert.ok(estimateNodeCardHeight(boundary) > estimateNodeCardHeight(plain))
  })

  it('泳道高度随其中最高的卡片增长', () => {
    const ports: readonly PortDefinition[] = [
      { name: 'left', type: 'number' },
      { name: 'right', type: 'number' },
      { name: 'extra', type: 'number' },
    ]
    const bare = executionLayout([[card('a')]], 'Stage')
    const wide = executionLayout([[card('a', ports)]], 'Stage')

    assert.ok(estimateNodeCardHeight(card('a', ports)) > estimateNodeCardHeight(card('a')))
    assert.ok(wide.bands[0]!.height > bare.bands[0]!.height)
    assert.equal(wide.bands[0]!.width, bare.bands[0]!.width)
  })
})

describe('workflow port declarations', () => {
  const ports: readonly PortDefinition[] = [
    { name: 'input1', type: 'string', description: 'kept' },
    { name: 'threshold', type: 'number' },
  ]

  it('新端口按所在侧命名，跳过已占用的编号，输出端口默认可选', () => {
    assert.deepEqual(appendWorkflowPort(ports, 'inputs'), [...ports, { name: 'input2', type: 'any' }])
    // An output is often fed by one branch of several, so requiring it would refuse to save.
    assert.deepEqual(appendWorkflowPort([], 'outputs'), [{ name: 'output1', type: 'any', required: false }])
  })

  it('改名和改类型保留端口的其余字段，删除只影响该端口', () => {
    assert.deepEqual(updateWorkflowPort(ports, 0, { name: 'reason', type: 'boolean' })[0], {
      name: 'reason',
      type: 'boolean',
      description: 'kept',
    })
    assert.deepEqual(removeWorkflowPort(ports, 0), [ports[1]])
  })

  it('空名和重名端口被标记为无法引用', () => {
    const conflicting: readonly PortDefinition[] = [
      { name: 'value', type: 'any' },
      { name: ' value ', type: 'any' },
      { name: '  ', type: 'any' },
      { name: 'other', type: 'any' },
    ]
    assert.deepEqual(
      conflicting.map((_port, index) => workflowPortFault(conflicting, index)),
      ['duplicate', 'duplicate', 'empty', undefined],
    )
  })

})

describe('workflow port defaults', () => {
  it('默认值按端口类型解析，字符串端口直接使用输入的文本', () => {
    assert.deepEqual(parseWorkflowPortDefault('hello', 'string'), { value: 'hello' })
    assert.deepEqual(parseWorkflowPortDefault('12.5', 'number'), { value: 12.5 })
    assert.deepEqual(parseWorkflowPortDefault('true', 'boolean'), { value: true })
    assert.deepEqual(parseWorkflowPortDefault('{"a":1}', 'any'), { value: { a: 1 } })
  })

  it('空文本表示没有默认值，尚未成形的文本不覆盖已声明的值', () => {
    assert.deepEqual(parseWorkflowPortDefault('   ', 'number'), { value: undefined })
    assert.equal(parseWorkflowPortDefault('-', 'number'), 'invalid')
    assert.equal(parseWorkflowPortDefault('{"a":', 'any'), 'invalid')
    assert.equal(parseWorkflowPortDefault('yes', 'boolean'), 'invalid')
  })

  it('默认值在文本与声明之间往返，清空时移除该字段', () => {
    const ports: readonly PortDefinition[] = [{ name: 'limit', type: 'number', default: 3 }]

    assert.equal(formatWorkflowPortDefault(ports[0]!.default, 'number'), '3')
    assert.equal(formatWorkflowPortDefault(undefined, 'number'), '')
    assert.equal(formatWorkflowPortDefault('plain', 'string'), 'plain')
    assert.ok(!Object.hasOwn(setWorkflowPortDefault(ports, 0, undefined)[0]!, 'default'))
    assert.equal(setWorkflowPortDefault(ports, 0, 9)[0]?.default, 9)
  })
})

describe('workflow boundary nodes', () => {
  const definition = parseEditorDefinition(JSON.stringify({
    name: 'io',
    nodes: [
      { id: 'in', type: WORKFLOW_INPUT_TYPE, config: {}, outputs: [{ name: 'left', type: 'number' }] },
      { id: 'add', type: 'sum', config: {}, position: { x: 400, y: 120 } },
      { id: 'out', type: WORKFLOW_OUTPUT_TYPE, config: {}, inputs: [{ name: 'total', type: 'number' }] },
    ],
    edges: [],
  }))

  it('工作流的签名从边界节点读出，方向按图中的数据流向', () => {
    assert.deepEqual(workflowInputPorts(definition).map(port => port.name), ['left'])
    assert.deepEqual(workflowOutputPorts(definition).map(port => port.name), ['total'])
    // A declared input is an output of the inputs node, so an edge can leave it.
    assert.deepEqual(boundaryPorts(definition.nodes[0]!), definition.nodes[0]!.outputs)
    assert.deepEqual(boundaryPorts(definition.nodes[2]!), definition.nodes[2]!.inputs)
  })

  it('替换声明端口写回节点自己的那一侧', () => {
    const ports: readonly PortDefinition[] = [{ name: 'renamed', type: 'string' }]

    assert.deepEqual(withBoundaryPorts(definition.nodes[0]!, ports).outputs, ports)
    assert.deepEqual(withBoundaryPorts(definition.nodes[2]!, ports).inputs, ports)
  })

  it('边界节点由自己的卡片绘制，其余节点用普通卡片', () => {
    const nodes = flowNodes(definition, new Map(), new Map())

    assert.deepEqual(nodes.map(node => node.type), ['boundary', 'workflow', 'boundary'])
  })

  it('边界节点像普通节点一样保存，坐标随节点一起往返', () => {
    const nodes = flowNodes(definition, new Map(), new Map())
    const dragged = nodes.map(node => node.id === 'in' ? { ...node, position: { x: -900, y: 40 } } : node)

    const saved = parseEditorDefinition(formatEditorDefinition(toDefinition(definition, dragged, [])))

    assert.deepEqual(saved.nodes.map(node => node.id), ['in', 'add', 'out'])
    assert.deepEqual(saved.nodes[0]?.position, { x: -900, y: 40 })
    assert.deepEqual(workflowInputPorts(saved).map(port => port.name), ['left'])
  })
})

describe('workflow port edits move their edges', () => {
  const edges = [
    { id: 'in', source: 'inputs', target: 'add', sourceHandle: 'data:left', targetHandle: 'data:left' },
    { id: 'out', source: 'add', target: 'outputs', sourceHandle: 'data:result', targetHandle: 'data:total' },
    { id: 'plain', source: 'add', target: 'other', sourceHandle: 'data:result', targetHandle: 'data:input' },
  ]

  it('改名把边带到新端口，两侧各自只动自己的一端', () => {
    const renamedInput = applyWorkflowPortEdit(edges, 'inputs', { kind: 'renamed', from: 'left', to: 'amount' })
    const renamedOutput = applyWorkflowPortEdit(edges, 'outputs', { kind: 'renamed', from: 'total', to: 'sum' })

    assert.equal(renamedInput[0]?.sourceHandle, 'data:amount')
    assert.deepEqual(renamedInput.slice(1), edges.slice(1))
    assert.equal(renamedOutput[1]?.targetHandle, 'data:sum')
    assert.deepEqual(renamedOutput[0], edges[0])
  })

  it('删除端口带走它的边，其余边和无关编辑不受影响', () => {
    assert.deepEqual(
      applyWorkflowPortEdit(edges, 'inputs', { kind: 'removed', name: 'left' }).map(edge => edge.id),
      ['out', 'plain'],
    )
    assert.deepEqual(applyWorkflowPortEdit(edges, 'outputs', { kind: 'other' }), edges)
    // An edge between two authored nodes never names a declared port, whatever it is called.
    assert.deepEqual(
      applyWorkflowPortEdit(edges, 'outputs', { kind: 'removed', name: 'input' }).map(edge => edge.id),
      ['in', 'out', 'plain'],
    )
  })

})

describe('run input values', () => {
  const ports: readonly PortDefinition[] = [
    { name: 'threshold', type: 'number', default: 3 },
    { name: 'label', type: 'string' },
  ]

  it('每个字段从声明的默认值开始，没有默认值的字段为空', () => {
    assert.deepEqual(workflowRunDefaults(ports), { threshold: '3', label: '' })
  })

  it('留空的输入交给默认值，没有默认值时报告缺失', () => {
    assert.deepEqual(
      workflowRunInputs(ports, { threshold: '', label: 'ship' }),
      { values: { label: 'ship' } },
    )
    assert.deepEqual(
      workflowRunInputs(ports, { threshold: '9', label: '' }),
      { fault: { name: 'label', kind: 'missing' } },
    )
  })

  it('与端口类型不符的文本被报告，不会送进运行', () => {
    assert.deepEqual(
      workflowRunInputs(ports, { threshold: 'many', label: 'ship' }),
      { fault: { name: 'threshold', kind: 'invalid' } },
    )
  })
})

describe('workflow result values', () => {
  const ports: readonly PortDefinition[] = [
    { name: 'verdict', type: 'string', required: false },
    { name: 'score', type: 'number', required: false },
  ]
  const record = (inputs?: Record<string, unknown>): NodeRunRecord => ({
    nodeId: NodeId('out'),
    status: 'completed',
    attempts: 1,
    startedAt: 0,
    runId: RunId('run'),
    ...(inputs === undefined ? {} : { inputs }),
  })

  it('按声明顺序列出送达输出端口的值', () => {
    assert.deepEqual(
      workflowResultValues(ports, record({ score: 4, verdict: 'ship' })),
      [{ name: 'verdict', value: 'ship' }, { name: 'score', value: 4 }],
    )
  })

  it('没有送达的端口不列出，运行尚未到达输出节点时没有任何值', () => {
    // A port fed only by a branch that did not run is absent, not null.
    assert.deepEqual(workflowResultValues(ports, record({ verdict: 'hold' })), [{ name: 'verdict', value: 'hold' }])
    assert.deepEqual(workflowResultValues(ports, record()), [])
    assert.deepEqual(workflowResultValues(ports, undefined), [])
  })
})
