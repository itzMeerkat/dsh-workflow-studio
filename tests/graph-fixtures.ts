/**
 * 整图分析与伪代码投影共用的图构造工具。
 */

import { analyzeWorkflow, indexNodeTypes } from '../src/shared/analysis.ts'
import { buildWorkflowIr, type WorkflowIr } from '../src/shared/ir.ts'
import { EdgeId, NodeId } from '../src/shared/types.ts'
import type {
  DagEdgeDefinition, DagNodeDefinition, DagWorkflowDefinition, NodeTypeSummary, PortDefinition,
} from '../src/shared/types.ts'
import { WORKFLOW_INPUT_TYPE, WORKFLOW_OUTPUT_TYPE } from '../src/shared/workflow-boundary.ts'

/**
 * 一个节点类型摘要；未给出的字段取普通 `run` 节点的默认值。
 * @param type - 类型名，同时作为标签。
 * @param fields - 覆盖的字段。
 */
export function nodeType(type: string, fields: Partial<NodeTypeSummary> = {}): NodeTypeSummary {
  return {
    type,
    label: type,
    description: '',
    sourcePlugin: 'test',
    execKind: 'plain',
    kinds: ['run'] as const,
    execOutputs: ['then'],
    inputs: [],
    outputs: [],
    controls: [],
    ...fields,
  }
}

const NUMBER_OUT: PortDefinition[] = [{ name: 'output', type: 'number' }]

export const NODE_TYPES: NodeTypeSummary[] = [
  nodeType('value', { outputs: NUMBER_OUT }),
  nodeType('flag', { outputs: [{ name: 'output', type: 'boolean' }] }),
  nodeType('double', { inputs: [{ name: 'input', type: 'number' }], outputs: NUMBER_OUT }),
  nodeType('sink', { inputs: [{ name: 'input', type: 'number' }] }),
  nodeType('text-sink', { inputs: [{ name: 'input', type: 'string' }] }),
  nodeType('branch', {
    execKind: 'decision',
    execOutputs: ['true', 'false'],
    inputs: [{ name: 'condition', type: 'boolean' }],
  }),
  nodeType('merge', {
    execKind: 'join',
    variadicInputs: { min: 2, outputType: 'same' },
    inputs: [
      { name: 'input1', type: 'any', required: false },
      { name: 'input2', type: 'any', required: false },
    ],
    outputs: [{ name: 'output', type: 'any' }],
  }),
  nodeType(WORKFLOW_INPUT_TYPE),
  nodeType(WORKFLOW_OUTPUT_TYPE),
]

/** 按类型名索引的 {@link NODE_TYPES}。 */
export const CATALOG = indexNodeTypes(NODE_TYPES)

/**
 * 一个定义的 IR。
 * @param definition - 待降级的定义。
 * @param catalog - 节点目录，默认 {@link CATALOG}。
 */
export function irOf(definition: DagWorkflowDefinition, catalog = CATALOG): WorkflowIr {
  return buildWorkflowIr(definition, catalog, analyzeWorkflow(definition, catalog))
}

/** 节点的类型名，或类型名加上该实例自带的字段。 */
export type NodeSpec = string | (Partial<Omit<DagNodeDefinition, 'id'>> & { type: string })

/**
 * 按简写构造一个定义。
 *
 * 接线写作 `源>目标`：两端可用 `:端口` 指定数据端口，源用 `.引脚` 时该边是执行边。
 * 边的 ID 依次为 `e0`、`e1`……
 * @param nodes - 节点 ID 到 {@link NodeSpec} 的映射。
 * @param wires - 接线简写。
 * @param fields - 覆盖定义自身的字段，例如工作流名称。
 */
export function workflow(
  nodes: Record<string, NodeSpec>,
  wires: readonly string[],
  fields: Partial<DagWorkflowDefinition> = {},
): DagWorkflowDefinition {
  const declared: DagNodeDefinition[] = Object.entries(nodes).map(([id, spec]) => ({
    id: NodeId(id),
    config: {},
    ...(typeof spec === 'string' ? { type: spec } : spec),
  }))
  const edges: DagEdgeDefinition[] = wires.map((wire, index) => {
    const id = EdgeId(`e${index}`)
    const [from, to] = wire.split('>')
    const [target, targetPort] = to!.split(':')
    const [source, pin] = from!.split('.')
    if (pin !== undefined) {
      return { id, kind: 'exec', source: NodeId(source!), target: NodeId(target!), sourcePort: pin }
    }
    const [dataSource, sourcePort] = from!.split(':')
    return {
      id,
      kind: 'data',
      source: NodeId(dataSource!),
      target: NodeId(target!),
      ...(sourcePort === undefined ? {} : { sourcePort }),
      ...(targetPort === undefined ? {} : { targetPort }),
    }
  })
  return { name: 'test', kind: 'run' as const, nodes: declared, edges, ...fields }
}
