/**
 * Host 引擎与浏览器编辑器共用的图与端口规则。
 * @module dsh-workflow-studio
 */

import type { PortDefinition } from './types.ts'

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
 * 节点实例的有效输入端口。实例声明的端口替换执行器声明的业务端口；带 `role` 的端口属于执行器，
 * 实例未声明同名端口时保留。
 * @param instance - 节点实例声明的输入端口，未声明时为 undefined。
 * @param declared - 执行器声明的输入端口。
 * @returns 有效输入端口。
 */
export function resolveInputPorts(
  instance: readonly PortDefinition[] | undefined,
  declared: readonly PortDefinition[],
): readonly PortDefinition[] {
  if (instance === undefined) return declared
  const names = new Set(instance.map(port => port.name))
  return [...instance, ...declared.filter(port => port.role !== undefined && !names.has(port.name))]
}
