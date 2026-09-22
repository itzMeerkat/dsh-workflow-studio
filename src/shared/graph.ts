/**
 * Host 引擎与浏览器编辑器共用的图与端口规则。
 * @module dsh-workflow-studio
 */

import type {
  DagDataEdge, DagEdgeDefinition, DagExecEdge, PortDefinition, WorkflowNodeExecutor,
} from './types.ts'

/** 每个节点的执行输入引脚名；执行边默认连到该引脚。 */
export const EXEC_RUN_PIN = 'run'

/** 节点完成时触发的执行输出引脚名；执行边默认由该引脚引出。 */
export const EXEC_THEN_PIN = 'then'

/**
 * 边是否为执行边。
 * @param edge - 任一边。
 */
export function isExecEdge(edge: DagEdgeDefinition): edge is DagExecEdge {
  return edge.kind === 'exec'
}

/**
 * 边是否为数据边。
 * @param edge - 任一边。
 */
export function isDataEdge(edge: DagEdgeDefinition): edge is DagDataEdge {
  return edge.kind === 'data'
}

/**
 * 执行器的执行输出引脚；未声明时只有 {@link EXEC_THEN_PIN}。
 * @param executor - 节点执行器，或浏览器目录中的节点类型。
 */
export function execOutputPins(executor: Pick<WorkflowNodeExecutor, 'execOutputs'>): readonly string[] {
  return executor.execOutputs ?? [EXEC_THEN_PIN]
}

/** 按目标节点分组的入边，数据边与执行边分开。 */
export interface InboundEdges {
  readonly data: ReadonlyMap<string, readonly DagDataEdge[]>
  readonly exec: ReadonlyMap<string, readonly DagExecEdge[]>
}

/**
 * 按目标节点索引入边。
 *
 * 调度与校验都要反复取某个节点的入边；对固定的定义建一次索引，避免每个节点各扫一遍全部边。
 * @param edges - 定义中的全部边。
 * @returns 数据边与执行边各自的目标索引；没有入边的节点不出现。
 */
export function inboundEdges(edges: readonly DagEdgeDefinition[]): InboundEdges {
  const data = new Map<string, DagDataEdge[]>()
  const exec = new Map<string, DagExecEdge[]>()
  for (const edge of edges) {
    if (isExecEdge(edge)) indexByTarget(exec, edge)
    else indexByTarget(data, edge)
  }
  return { data, exec }
}

function indexByTarget<E extends { readonly target: string }>(index: Map<string, E[]>, edge: E): void {
  const existing = index.get(edge.target)
  if (existing === undefined) index.set(edge.target, [edge])
  else existing.push(edge)
}

/** 执行边引脚不成立的一端。 */
export type ExecPinFault = 'source' | 'target'

/**
 * 执行边的两个引脚是否成立。
 *
 * Host 校验与浏览器连线规则共用本判断，两侧据此给出各自的错误信息；分开实现会随引脚集合的演进而分歧。
 * @param sourcePins - 源节点声明的执行输出引脚。
 * @param sourcePin - 边引出的源引脚。
 * @param targetPin - 边连入的目标引脚。
 * @returns 不成立的一端，或两端都成立时为 undefined。
 */
export function execPinFault(
  sourcePins: readonly string[],
  sourcePin: string,
  targetPin: string,
): ExecPinFault | undefined {
  if (!sourcePins.includes(sourcePin)) return 'source'
  return targetPin === EXEC_RUN_PIN ? undefined : 'target'
}

/**
 * 执行边引出的源引脚名。
 * @param edge - 执行边。
 */
export function execSourcePin(edge: DagExecEdge): string {
  return edge.sourcePort ?? EXEC_THEN_PIN
}

/**
 * 执行边连入的目标引脚名。
 * @param edge - 执行边。
 */
export function execTargetPin(edge: DagExecEdge): string {
  return edge.targetPort ?? EXEC_RUN_PIN
}

/** 按拓扑层级分组的节点；`cyclic` 为位于环上或依赖环的节点。 */
export interface TopologicalLevels<N> {
  readonly levels: N[][]
  readonly cyclic: N[]
}

/**
 * 使用 Kahn 算法把节点分为可并行执行的层级。
 * @param nodes - 图中的节点。
 * @param edges - 有向边；两个节点间可以有多条边。
 * @returns 按执行顺序排列的层级，以及无法排序的节点。
 * @throws 边引用不存在的节点时。
 */
export function topologicalLevels<N extends { readonly id: string }>(
  nodes: readonly N[],
  edges: readonly { readonly id: string; readonly source: string; readonly target: string }[],
): TopologicalLevels<N> {
  const inDegree = new Map(nodes.map(node => [node.id, 0]))
  const targets = new Map(nodes.map(node => [node.id, [] as string[]]))
  for (const edge of edges) {
    const outgoing = targets.get(edge.source)
    if (outgoing === undefined) throw new Error(`边 ${edge.id} 引用不存在的源节点 ${edge.source}`)
    const degree = inDegree.get(edge.target)
    if (degree === undefined) throw new Error(`边 ${edge.id} 引用不存在的目标节点 ${edge.target}`)
    outgoing.push(edge.target)
    inDegree.set(edge.target, degree + 1)
  }

  const byId = new Map(nodes.map(node => [node.id, node]))
  const levels: N[][] = []
  let frontier = nodes.filter(node => inDegree.get(node.id) === 0).map(node => node.id)
  while (frontier.length > 0) {
    levels.push(frontier.map(id => byId.get(id)!))
    const next: string[] = []
    for (const id of frontier) {
      for (const target of targets.get(id)!) {
        const degree = inDegree.get(target)! - 1
        inDegree.set(target, degree)
        if (degree === 0) next.push(target)
      }
    }
    frontier = next
  }
  const sorted = new Set(levels.flat().map(node => node.id))
  return { levels, cyclic: nodes.filter(node => !sorted.has(node.id)) }
}

/**
 * 输出端口能否连接到输入端口：任一端为 `any` 或两端类型相同。
 * @param source - 上游输出端口。
 * @param target - 下游输入端口。
 */
export function portsAreCompatible(source: PortDefinition, target: PortDefinition): boolean {
  return source.type === 'any' || target.type === 'any' || source.type === target.type
}

/**
 * 检查端口名不重复。
 * @param owner - 错误信息中的端口所有者。
 * @param kind - 错误信息中的端口方向。
 * @param ports - 待检查的端口。
 * @throws 存在同名端口时。
 */
export function assertUniquePortNames(owner: string, kind: string, ports: readonly PortDefinition[]): void {
  const names = new Set<string>()
  for (const port of ports) {
    if (names.has(port.name)) throw new Error(`${owner} 的${kind}端口 ${port.name} 重复`)
    names.add(port.name)
  }
}
