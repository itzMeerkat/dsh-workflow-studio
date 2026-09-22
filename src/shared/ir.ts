/**
 * 工作流的中间表示：按执行顺序和分支条件排好的语句树。
 *
 * 定义是一张图，读它要逐条边追踪；生成器要的是顺序、嵌套和每个值的来源。IR 把前者算成后者一次，
 * 之后每种语言只负责怎么写。IR 不含任何语言的决定：这里没有标识符、没有缩进。
 * @module dsh-workflow-studio
 */

import { atomNode, atomPin, type WorkflowAnalysis } from './analysis.ts'
import { isDataEdge } from './graph.ts'
import { WORKFLOW_INPUT_TYPE, WORKFLOW_OUTPUT_TYPE } from './workflow-boundary.ts'
import type {
  DagNodeDefinition, DagWorkflowDefinition, NodeExecKind, NodeId, NodeTypeSummary, PortDefinition,
  WorkflowKind,
} from './types.ts'

/** IR 中被引用的一个值。 */
export type IrValue =
  /** 工作流自身的一个输入端口。 */
  | { readonly kind: 'input'; readonly port: string }
  /** 某个节点某个输出端口产生的值。 */
  | { readonly kind: 'output'; readonly node: NodeId; readonly port: string }

/** 送入一个输入端口的值。 */
export interface IrArgument {
  readonly port: string
  readonly value: IrValue
}

/** 调用一个节点。 */
export interface IrCall {
  readonly kind: 'call'
  readonly node: NodeId
  readonly type: string
  /** 作者给这个节点的名字；未命名时不存在。 */
  readonly label?: string
  readonly execKind: NodeExecKind
  /** 节点配置，例如代码节点携带的代码。 */
  readonly config: Record<string, unknown>
  /** 节点声明的执行输出引脚，按声明顺序。 */
  readonly pins: readonly string[]
  /** 已接线的输入端口及其来源，按端口声明顺序；未接线的端口不出现。 */
  readonly args: readonly IrArgument[]
  /** 该节点产生的输出端口。 */
  readonly results: readonly PortDefinition[]
}

/** 工作流交付它声明的输出；未接线的端口不出现。 */
export interface IrOutputs {
  readonly kind: 'outputs'
  readonly bindings: readonly IrArgument[]
}

/** 只在 {@link IrGuard.gate} 触发 `pin` 时执行的一段。 */
export interface IrArm {
  readonly pin: string
  readonly body: IrBlock
}

/**
 * 由一个节点的执行引脚守卫的块。
 *
 * 有两个 arm 时它们是一个双引脚决策节点的两个引脚，任何一次运行恰好执行其中一个，因此可以写成 if/else；
 * 其他情况下只有一个 arm。
 */
export interface IrGuard {
  readonly kind: 'guard'
  /** 触发引脚的节点；它的调用在树中先于本项出现。 */
  readonly gate: IrCall
  readonly arms: readonly IrArm[]
}

/** 块中的一项。 */
export type IrItem = IrCall | IrOutputs | IrGuard

/** 一段顺序执行的项。 */
export type IrBlock = readonly IrItem[]

/** 一个工作流的完整 IR。 */
export interface WorkflowIr {
  readonly name: string
  readonly kind: WorkflowKind
  /** 工作流声明的输入端口，即它的参数；没有输入边界节点时为空。 */
  readonly inputs: readonly PortDefinition[]
  /** 工作流声明的输出端口，即它的结果；没有输出边界节点时为空。 */
  readonly outputs: readonly PortDefinition[]
  readonly body: IrBlock
}

/**
 * 把一个定义降为 IR。
 *
 * 前提与 {@link analyzeWorkflow} 相同，`analysis` 就是它对同一定义、同一目录的结果。
 * 每个节点写在它的 guard 对应的块中、写在它的全部上游之后，因此 IR 的执行语义与图一致；
 * 在此之内，调度尽量让同一分支的节点连续、让决策节点的两侧相邻，使块尽可能少。
 * @param definition - 待降级的工作流定义。
 * @param catalog - 类型名到节点类型的索引。
 * @param analysis - {@link analyzeWorkflow} 对该定义的结果。
 * @returns 该工作流的 IR。
 */
export function buildWorkflowIr(
  definition: DagWorkflowDefinition,
  catalog: ReadonlyMap<string, NodeTypeSummary>,
  analysis: WorkflowAnalysis,
): WorkflowIr {
  const rank = new Map(analysis.order.map((node, index) => [node.id, index]))
  // 条件按决策节点的拓扑位置由外到内排列。
  const paths = new Map(analysis.order.map(node => [
    node.id,
    [...analysis.guards.get(node.id)!].sort((left, right) => rank.get(atomNode(left))! - rank.get(atomNode(right))!),
  ]))
  const lower = new Lowering(definition, catalog)
  const calls = new Map<NodeId, IrCall>()

  const root: MutableItem[] = []
  const open: { atom: string; items: MutableItem[] }[] = []
  for (const node of schedule(definition, analysis.order, paths)) {
    const path = paths.get(node.id)!
    open.length = commonPrefix(open.map(block => block.atom), path)
    for (const atom of path.slice(open.length)) {
      const parent = open.at(-1)?.items ?? root
      const arm = { pin: atomPin(atom), body: [] as MutableItem[] }
      const last = parent.at(-1)
      if (last?.kind === 'guard' && complements(last, atom)) last.arms.push(arm)
      else parent.push({ kind: 'guard', gate: calls.get(atomNode(atom))!, arms: [arm] })
      open.push({ atom, items: arm.body })
    }
    const item = lower.item(node)
    if (item === undefined) continue
    if (item.kind === 'call') calls.set(item.node, item)
    ;(open.at(-1)?.items ?? root).push(item)
  }

  const inputNode = definition.nodes.find(node => node.type === WORKFLOW_INPUT_TYPE)
  const outputNode = definition.nodes.find(node => node.type === WORKFLOW_OUTPUT_TYPE)
  return {
    name: definition.name,
    kind: definition.kind,
    inputs: inputNode === undefined ? [] : lower.outputsOf(inputNode),
    outputs: outputNode === undefined ? [] : lower.inputsOf(outputNode),
    body: root,
  }
}

type MutableItem = IrCall | IrOutputs | { readonly kind: 'guard'; readonly gate: IrCall; readonly arms: IrArm[] }

/** `atom` 是否是 `guard` 已有 arm 的另一侧：同一个双引脚决策节点的另一个引脚。 */
function complements(guard: { readonly gate: IrCall; readonly arms: readonly IrArm[] }, atom: string): boolean {
  return guard.gate.node === atomNode(atom)
    && guard.gate.execKind === 'decision'
    && guard.gate.pins.length === 2
    && guard.arms.length === 1
    && guard.arms[0]!.pin !== atomPin(atom)
}

function commonPrefix(left: readonly string[], right: readonly string[]): number {
  let length = 0
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1
  return length
}

/**
 * 一个让同一分支的节点尽量连续的拓扑序。
 *
 * 每一步只从上游都已排好的节点中选，所以结果总是合法的拓扑序；选哪个由与上一个节点的条件路径
 * 共同前缀的长度决定，留在当前块中的优先；路径在分叉处落到同一决策节点另一引脚的次之，
 * 使两侧相邻写成 if/else；其余按原拓扑序。
 */
function schedule(
  definition: DagWorkflowDefinition,
  order: readonly DagNodeDefinition[],
  paths: ReadonlyMap<NodeId, readonly string[]>,
): DagNodeDefinition[] {
  const rank = new Map(order.map((node, index) => [node.id, index]))
  const nodes = new Map(order.map(node => [node.id, node]))
  const waiting = new Map(order.map(node => [node.id, 0]))
  const successors = new Map<NodeId, NodeId[]>()
  for (const edge of definition.edges) {
    waiting.set(edge.target, waiting.get(edge.target)! + 1)
    successors.set(edge.source, [...successors.get(edge.source) ?? [], edge.target])
  }

  const ready = order.filter(node => waiting.get(node.id) === 0)
  const scheduled: DagNodeDefinition[] = []
  let current: readonly string[] = []
  const affinity = (node: DagNodeDefinition): number => {
    const path = paths.get(node.id)!
    const common = commonPrefix(current, path)
    const sibling = common < current.length && common < path.length
      && atomNode(current[common]!) === atomNode(path[common]!)
    return common * 2 + (sibling ? 1 : 0)
  }
  while (ready.length > 0) {
    let best = 0
    for (let index = 1; index < ready.length; index += 1) {
      const gain = affinity(ready[index]!) - affinity(ready[best]!)
      if (gain > 0 || (gain === 0 && rank.get(ready[index]!.id)! < rank.get(ready[best]!.id)!)) best = index
    }
    const [node] = ready.splice(best, 1)
    scheduled.push(node!)
    current = paths.get(node!.id)!
    for (const next of successors.get(node!.id) ?? []) {
      const left = waiting.get(next)! - 1
      waiting.set(next, left)
      if (left === 0) ready.push(nodes.get(next)!)
    }
  }
  return scheduled
}

/** 把一个节点降为一项；需要定义中的数据边和节点目录。 */
class Lowering {
  private readonly sources: ReadonlyMap<string, IrValue>

  constructor(definition: DagWorkflowDefinition, private readonly catalog: ReadonlyMap<string, NodeTypeSummary>) {
    const types = new Map(definition.nodes.map(node => [node.id, node.type]))
    this.sources = new Map(definition.edges.filter(isDataEdge).map((edge) => {
      const port = edge.sourcePort ?? 'output'
      // 输入边界节点的每个输出端口就是工作流的一个输入，生成器不必知道那个节点的存在。
      const value: IrValue = types.get(edge.source) === WORKFLOW_INPUT_TYPE
        ? { kind: 'input', port }
        : { kind: 'output', node: edge.source, port }
      return [argumentKey(edge.target, edge.targetPort ?? 'input'), value]
    }))
  }

  /** 节点对应的项；输入边界节点只是签名，没有项。 */
  item(node: DagNodeDefinition): IrCall | IrOutputs | undefined {
    if (node.type === WORKFLOW_INPUT_TYPE) return undefined
    if (node.type === WORKFLOW_OUTPUT_TYPE) return { kind: 'outputs', bindings: this.argumentsOf(node) }
    const summary = this.catalog.get(node.type)!
    return {
      kind: 'call',
      node: node.id,
      type: node.type,
      ...(node.label === undefined ? {} : { label: node.label }),
      execKind: summary.execKind,
      config: node.config,
      pins: summary.execOutputs,
      args: this.argumentsOf(node),
      results: this.outputsOf(node),
    }
  }

  inputsOf(node: DagNodeDefinition): readonly PortDefinition[] {
    return node.inputs ?? this.catalog.get(node.type)!.inputs
  }

  outputsOf(node: DagNodeDefinition): readonly PortDefinition[] {
    return node.outputs ?? this.catalog.get(node.type)!.outputs
  }

  private argumentsOf(node: DagNodeDefinition): IrArgument[] {
    return this.inputsOf(node).flatMap((port) => {
      const value = this.sources.get(argumentKey(node.id, port.name))
      return value === undefined ? [] : [{ port: port.name, value }]
    })
  }
}

function argumentKey(node: NodeId, port: string): string {
  return `${node}\u0000${port}`
}
