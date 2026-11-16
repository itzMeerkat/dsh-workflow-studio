/**
 * 子工作流：把另一个已保存的工作流当作一个节点。
 *
 * 节点只记下被嵌入工作流的 ID，是链接而不是副本：它的端口就是那个工作流声明的输入和输出，改动那个工作流就改动每个
 * 嵌入它的地方。运行开始时引擎把它展开成那个工作流的节点。
 * @module dsh-workflow-studio
 */

import { WorkflowId, type DagNodeDefinition, type DagWorkflowDefinition, type PortDefinition } from './types.ts'
import { workflowInputPorts, workflowOutputPorts } from './workflow-boundary.ts'

/** 嵌入另一个工作流的节点类型。 */
export const SUBWORKFLOW_TYPE = 'subworkflow'

/** 子工作流节点存放被嵌入工作流 ID 的配置字段。 */
export const SUBWORKFLOW_FIELD = 'workflow'

/** 展开后站在子工作流节点位置上的节点：把嵌入处送来的值交给子工作流，并让子工作流的每个节点等它。 */
export const SUBWORKFLOW_ENTRY_TYPE = 'subworkflow-entry'

/** 展开后代替子工作流输出边界的节点：它完成即子工作流完成，嵌入处的后继等它。 */
export const SUBWORKFLOW_EXIT_TYPE = 'subworkflow-exit'

/** 只由运行开始时的展开放置的节点类型；作者不能放置它们，编辑器也不列出它们。 */
export const EXPANSION_NODE_TYPES: readonly string[] = [SUBWORKFLOW_ENTRY_TYPE, SUBWORKFLOW_EXIT_TYPE]

/** 按 ID 读取已保存的工作流。 */
export type WorkflowLookup = (id: WorkflowId) => DagWorkflowDefinition | undefined

/**
 * 子工作流节点嵌入的工作流。
 * @param config - 节点配置。
 */
export function subworkflowOf(config: Readonly<Record<string, unknown>>): WorkflowId {
  return WorkflowId(String(config[SUBWORKFLOW_FIELD] ?? ''))
}

/**
 * 一个工作流作为节点时的端口：它声明的输入和输出。有默认值的输入可以不接线。
 * @param definition - 被嵌入的工作流。
 * @returns 节点的输入和输出端口，只含名称、类型和必需性。
 */
export function subworkflowPorts(definition: DagWorkflowDefinition): { inputs: PortDefinition[]; outputs: PortDefinition[] } {
  return {
    inputs: workflowInputPorts(definition).map(({ name, type, default: value }) =>
      value === undefined ? { name, type } : { name, type, required: false }),
    outputs: workflowOutputPorts(definition).map(({ name, type }) => ({ name, type })),
  }
}

/**
 * 按被嵌入的工作流重写每个子工作流节点的端口，并去掉接在它已不再声明的端口上的数据边。
 *
 * 被嵌入的工作流读不到时保留节点原有的端口，接线不因列表尚未加载而丢失。
 * @param definition - 工作流定义。
 * @param lookup - 读取已保存的工作流。
 * @returns 子工作流节点的端口与被嵌入工作流一致的定义；已经一致时就是 `definition` 本身，调用方可以按引用判断有没有变化。
 */
export function withSubworkflows(definition: DagWorkflowDefinition, lookup: WorkflowLookup): DagWorkflowDefinition {
  let changed = false
  const nodes = definition.nodes.map((node) => {
    const embedded = node.type === SUBWORKFLOW_TYPE ? lookup(subworkflowOf(node.config)) : undefined
    if (embedded === undefined) return node
    const { inputs, outputs } = subworkflowPorts(embedded)
    if (samePorts(node.inputs, inputs) && samePorts(node.outputs, outputs)) return node
    changed = true
    return { ...node, inputs, outputs }
  })
  const byId = new Map(nodes.map(node => [node.id, node]))
  const declares = (node: DagNodeDefinition, ports: DagNodeDefinition['inputs'], port: string): boolean =>
    node.type !== SUBWORKFLOW_TYPE || (ports ?? []).some(candidate => candidate.name === port)
  const edges = definition.edges.filter((edge) => {
    if (edge.kind === 'exec') return true
    const source = byId.get(edge.source)!
    const target = byId.get(edge.target)!
    return declares(source, source.outputs, edge.sourcePort ?? 'output')
      && declares(target, target.inputs, edge.targetPort ?? 'input')
  })
  return changed || edges.length !== definition.edges.length ? { ...definition, nodes, edges } : definition
}

/** 两组端口的名称、类型和必需性逐个相同；{@link subworkflowPorts} 给出的端口只有这三项。 */
function samePorts(current: readonly PortDefinition[] | undefined, next: readonly PortDefinition[]): boolean {
  return current !== undefined && current.length === next.length && current.every((port, index) => {
    const other = next[index]!
    return port.name === other.name && port.type === other.type && (port.required ?? true) === (other.required ?? true)
      && port.description === undefined && port.display === undefined && port.default === undefined
  })
}

/**
 * 嵌入会不会形成环：被嵌入的工作流就是嵌入方，或直接或间接嵌入了嵌入方。
 * @param parentId - 嵌入方的 ID；尚未保存的工作流没有 ID，也就不会被任何工作流嵌入。
 * @param childId - 被嵌入的工作流的 ID。
 * @param child - 被嵌入的工作流。
 * @param lookup - 读取已保存的工作流，用于沿嵌入关系查找环。
 */
export function embedsCycle(
  parentId: WorkflowId | undefined,
  childId: WorkflowId,
  child: DagWorkflowDefinition,
  lookup: WorkflowLookup,
): boolean {
  return parentId !== undefined && (childId === parentId || embeds(child, parentId, lookup))
}

/**
 * 一个工作流是否直接或间接嵌入了另一个。
 * @param definition - 从这个工作流开始查找。
 * @param id - 要找的工作流。
 * @param lookup - 读取已保存的工作流。
 * @returns 沿嵌入关系能到达 `id` 时为 true；引用的工作流不存在时，那条路径到此为止。
 */
export function embeds(definition: DagWorkflowDefinition, id: WorkflowId, lookup: WorkflowLookup): boolean {
  const seen = new Set<WorkflowId>()
  const reaches = (from: DagWorkflowDefinition): boolean => from.nodes.some((node) => {
    if (node.type !== SUBWORKFLOW_TYPE) return false
    const ref = subworkflowOf(node.config)
    if (ref === id) return true
    if (seen.has(ref)) return false
    seen.add(ref)
    const child = lookup(ref)
    return child !== undefined && reaches(child)
  })
  return reaches(definition)
}
