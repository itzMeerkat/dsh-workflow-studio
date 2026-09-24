/**
 * Host 侧的子工作流：运行开始时把子工作流节点展开成它嵌入的工作流的节点。
 *
 * 展开后的图只含普通节点，调度、跳过传播、暂停、恢复和运行记录都不知道子工作流的存在。
 * @module dsh-workflow-studio
 */

import { EXEC_THEN_PIN, execSourcePin, isDataEdge, isExecEdge } from './shared/graph.ts'
import { signaturePorts } from './shared/language.ts'
import {
  SUBWORKFLOW_TYPE, subworkflowOf, workflowSignature, type WorkflowLookup,
} from './shared/subworkflow.ts'
import {
  EdgeId, NodeId, type DagEdgeDefinition, type DagExecEdge, type DagNodeDefinition, type DagWorkflowDefinition,
  type WorkflowId,
} from './shared/types.ts'
import {
  WORKFLOW_OUTPUT_TYPE, workflowInputNode, workflowInputPorts, workflowOutputNode,
} from './shared/workflow-boundary.ts'

/** 展开后站在子工作流节点位置上的节点：把嵌入处送来的值交给子工作流，并让子工作流的每个节点等它。 */
export const SUBWORKFLOW_ENTRY_TYPE = 'subworkflow-entry'

/** 展开后代替子工作流输出边界的节点：它完成即子工作流完成，嵌入处的后继等它。 */
export const SUBWORKFLOW_EXIT_TYPE = 'subworkflow-exit'

/** 入口节点存放子工作流输入默认值的配置字段。 */
export const SUBWORKFLOW_DEFAULTS = 'defaults'

/**
 * 把一个 `run` 工作流的子工作流节点展开成它们嵌入的工作流的节点，嵌套的子工作流一并展开。
 *
 * 子工作流节点 `S` 展开为：
 * - 一个 ID 仍为 `S` 的入口节点，输入就是 `S` 的输入，因此连进 `S` 的边原样保留；它把收到的值和子工作流输入的默认值
 *   作为输出，代替子工作流的输入边界；
 * - 子工作流其余的节点和边，ID 前加 `S/`，输出边界换成出口节点；
 * - 从入口到每个展开节点的执行边，OR 连接点除外，它由自己的入执行边决定何时运行。于是整个子工作流等 `S` 的输入
 *   到齐才开始，`S` 被跳过时它的每个节点都被跳过，与单个节点一致；
 * - 从 `S` 引出的数据边改由子工作流输出端口的来源引出，没有来源的端口不再引出边，读 `S` 输出的节点因此等它读的值
 *   而不是整个子工作流；从 `S` 引出的执行边改由出口引出，它们的目标等子工作流完成。
 * @param definition - 已保存的 `run` 工作流。
 * @param lookup - 读取已保存的工作流。
 * @param isJoin - 节点类型是否为 OR 连接点。
 * @returns 不含子工作流节点的定义。
 * @throws 嵌入的工作流不存在，或嵌入关系成环时。
 */
export function expandSubworkflows(
  definition: DagWorkflowDefinition,
  lookup: WorkflowLookup,
  isJoin: (type: string) => boolean,
): DagWorkflowDefinition {
  return expand(definition, lookup, isJoin, [])
}

function expand(
  definition: DagWorkflowDefinition,
  lookup: WorkflowLookup,
  isJoin: (type: string) => boolean,
  trail: readonly WorkflowId[],
): DagWorkflowDefinition {
  const embedded = new Set(definition.nodes.filter(node => node.type === SUBWORKFLOW_TYPE).map(node => node.id))
  if (embedded.size === 0) return definition
  const nodes = definition.nodes.filter(node => !embedded.has(node.id))
  const edges: DagEdgeDefinition[] = definition.edges.filter(edge => !embedded.has(edge.source))
  const outgoing: DagEdgeDefinition[] = []
  for (const node of definition.nodes) {
    if (!embedded.has(node.id)) continue
    const inlined = inline(node, lookup, isJoin, trail)
    nodes.push(...inlined.nodes)
    edges.push(...inlined.edges)
    for (const edge of definition.edges) {
      if (edge.source !== node.id) continue
      if (isExecEdge(edge)) {
        outgoing.push({ ...edge, source: inlined.exit })
        continue
      }
      const feed = inlined.results.get(edge.sourcePort ?? 'output')
      if (feed === undefined) continue
      const { sourcePort: _port, ...rest } = edge
      outgoing.push({ ...rest, source: feed.source, ...(feed.sourcePort === undefined ? {} : { sourcePort: feed.sourcePort }) })
    }
  }
  return { ...definition, nodes, edges: [...edges, ...outgoing] }
}

/** 一个子工作流节点展开出的节点和边，出口的 ID，以及子工作流每个输出端口的来源。 */
interface Inlined {
  readonly nodes: readonly DagNodeDefinition[]
  readonly edges: readonly DagEdgeDefinition[]
  readonly exit: NodeId
  readonly results: ReadonlyMap<string, { readonly source: NodeId; readonly sourcePort?: string }>
}

function inline(
  node: DagNodeDefinition,
  lookup: WorkflowLookup,
  isJoin: (type: string) => boolean,
  trail: readonly WorkflowId[],
): Inlined {
  const ref = subworkflowOf(node.config)
  if (trail.includes(ref)) throw new Error(`子工作流嵌入成环：${[...trail, ref].join(' → ')}`)
  const authored = lookup(ref)
  if (authored === undefined) throw new Error(`子工作流节点 ${node.id} 嵌入的工作流 ${ref} 不存在`)
  const child = expand(authored, lookup, isJoin, [...trail, ref])
  const input = workflowInputNode(child)
  const output = workflowOutputNode(child)
  const scoped = (id: string): NodeId => NodeId(`${node.id}/${id}`)
  const at = (id: NodeId): NodeId => id === input?.id ? node.id : scoped(id)
  const exit = scoped(output?.id ?? WORKFLOW_OUTPUT_TYPE)

  const ports = workflowInputPorts(child)
  const entry: DagNodeDefinition = {
    id: node.id,
    type: SUBWORKFLOW_ENTRY_TYPE,
    ...(node.label === undefined ? {} : { label: node.label }),
    config: {
      [SUBWORKFLOW_DEFAULTS]: Object.fromEntries(ports.flatMap(port => port.default === undefined ? [] : [[port.name, port.default]])),
    },
    inputs: signaturePorts(workflowSignature(child).parameters),
    outputs: ports.map(({ name, type }) => ({ name, type })),
  }
  const body = child.nodes
    .filter(item => item.id !== input?.id)
    .map(item => item.id === output?.id ? { ...item, id: exit, type: SUBWORKFLOW_EXIT_TYPE } : { ...item, id: scoped(item.id) })
  if (output === undefined) body.push({ id: exit, type: SUBWORKFLOW_EXIT_TYPE, config: {} })

  const edges: DagEdgeDefinition[] = child.edges.map(edge =>
    ({ ...edge, id: EdgeId(`${node.id}/${edge.id}`), source: at(edge.source), target: at(edge.target) }))
  const gated = new Set(edges.filter(edge => isExecEdge(edge) && edge.source === node.id && execSourcePin(edge) === EXEC_THEN_PIN)
    .map(edge => edge.target))
  for (const item of body) {
    if (!isJoin(item.type) && !gated.has(item.id)) edges.push(execEdge(`${item.id}#after:${node.id}`, node.id, item.id))
  }
  const results = new Map(edges.filter(edge => isDataEdge(edge) && edge.target === exit).map(edge =>
    [edge.targetPort ?? 'input', { source: edge.source, ...(edge.sourcePort === undefined ? {} : { sourcePort: edge.sourcePort }) }] as const))
  return { nodes: [entry, ...body], edges, exit, results }
}

function execEdge(id: string, source: NodeId, target: NodeId): DagExecEdge {
  return { id: EdgeId(id), kind: 'exec', source, target }
}
