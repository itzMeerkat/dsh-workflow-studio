/**
 * 工作流静态分析：条件引脚 guard、数据可达性诊断与输出端口类型推断。
 *
 * 与逐条规则校验的区别是范围而不是时机：校验的每条规则只看一个节点或一条边，本模块的每条结论都来自整张图。
 * Host 在保存时据此拒绝在任何分支下都错误的接线，浏览器用同一份结果在画布上标注告警，因此两侧只有一份实现。
 * @module dsh-workflow-studio
 */

import { execSourcePin, inboundEdges, isDataEdge, nodeExecPins, topologicalLevels } from './graph.ts'
import { NodeId } from './types.ts'
import { WORKFLOW_OUTPUT_TYPE } from './workflow-boundary.ts'
import type {
  DagDataEdge, DagNodeDefinition, DagWorkflowDefinition, EdgeId, NodeTypeSummary, PortType,
} from './types.ts'

/**
 * 节点执行所依赖的条件引脚集合，元素为 {@link pinAtom} 编码的原子。
 *
 * 空集表示运行到达该节点时它必然执行。`guard(源) ⊆ guard(目标)` 就是"目标执行则源必然也执行过"。
 */
export type Guard = ReadonlySet<string>

/**
 * 一条静态分析诊断。`code` 决定其余字段。
 *
 * 诊断只给出定位与事实，不含文案：Host 的异常与浏览器的画布标注需要不同的措辞，
 * 各自从这些字段组织，因此同一个事实不会有两份措辞在两侧漂移。
 */
export type WorkflowDiagnostic =
  | {
    /** 必需输入的数据源可能被跳过，目标节点会带着缺失的输入执行并失败。 */
    readonly code: 'starved-input'
    /** 诊断归属的节点，也是画布上被标注的节点。 */
    readonly nodeId: NodeId
    readonly edgeId: EdgeId
    readonly sourceId: NodeId
    /** 目标节点上接收该边的输入端口。 */
    readonly port: string
    /** 源依赖它触发而目标不依赖的条件引脚，`节点.引脚` 形式。 */
    readonly pin: string
  }
  | {
    /** 工作流输出端口在部分分支下收不到值。 */
    readonly code: 'output-gap'
    readonly nodeId: NodeId
    readonly edgeId: EdgeId
    readonly sourceId: NodeId
    readonly port: string
    readonly pin: string
  }
  | {
    /** 分支合并的两个数据源可能同时送达，而它只接受一个。 */
    readonly code: 'merge-overlap'
    readonly nodeId: NodeId
    /** 无法证明互斥的两个数据源。 */
    readonly sources: readonly [NodeId, NodeId]
  }
  | {
    /** 分支合并的数据源可能都不送达，而它至少需要一个。 */
    readonly code: 'merge-gap'
    readonly nodeId: NodeId
  }
  | {
    /** 推断出的上游产出类型与下游端口声明的类型不符。 */
    readonly code: 'type-mismatch'
    readonly nodeId: NodeId
    readonly edgeId: EdgeId
    readonly port: string
    /** 推断出的上游产出类型与端口声明的类型。 */
    readonly types: readonly [PortType, PortType]
  }

/** 静态分析发现的问题类别。 */
export type WorkflowDiagnosticCode = WorkflowDiagnostic['code']

/**
 * 每类问题的严重程度。
 *
 * `error` 表示接线在任何一次运行中都会出错，保存据此拒绝；`warning` 表示只在部分分支下出错，
 * 或分析无法证明它正确。分析对运行期的选择一无所知，因此告警不阻止保存。
 */
export const DIAGNOSTIC_SEVERITY = {
  'starved-input': 'error',
  'output-gap': 'warning',
  'merge-overlap': 'warning',
  'merge-gap': 'warning',
  'type-mismatch': 'warning',
} as const satisfies Record<WorkflowDiagnosticCode, 'error' | 'warning'>

/** 整张图的分析结果。 */
export interface WorkflowAnalysis {
  /** 全部节点的一个拓扑序；上游先于下游。 */
  readonly order: readonly DagNodeDefinition[]
  /** 每个节点的条件引脚集合。 */
  readonly guards: ReadonlyMap<NodeId, Guard>
  /** 按定义中边、节点的先后排列的诊断。 */
  readonly diagnostics: readonly WorkflowDiagnostic[]
}

/** 条件引脚原子的编码，用于集合运算。 */
function pinAtom(node: NodeId, pin: string): string {
  return `${node}\u0000${pin}`
}

/**
 * 原子所属的节点。
 * @param atom - {@link Guard} 中的条件引脚原子。
 */
export function atomNode(atom: string): NodeId {
  return NodeId(atom.slice(0, atom.indexOf('\u0000')))
}

/**
 * 原子对应的执行输出引脚名。
 * @param atom - {@link Guard} 中的条件引脚原子。
 */
export function atomPin(atom: string): string {
  return atom.slice(atom.indexOf('\u0000') + 1)
}

/** 诊断中展示的 `节点.引脚`。 */
function formatAtom(atom: string): string {
  return atom.replace('\u0000', '.')
}

/**
 * 分析一个无环、每条边两端都在图中、且每个节点类型都在目录中的定义。
 *
 * 三项前提由调用方保证：Host 侧先经校验解析节点类型、检查边的两端并拒绝环，
 * 浏览器侧在任一前提不成立时不调用本函数。
 * @param definition - 待分析的工作流定义。
 * @param catalog - 类型名到节点类型的索引。
 * @returns 每个节点的 guard 与全部诊断。
 */
export function analyzeWorkflow(
  definition: DagWorkflowDefinition,
  catalog: ReadonlyMap<string, NodeTypeSummary>,
): WorkflowAnalysis {
  const nodes = new Map(definition.nodes.map(node => [node.id, node]))
  const typeOf = (node: NodeId): NodeTypeSummary => catalog.get(nodes.get(node)!.type)!
  const pinsOf = (node: NodeId): readonly string[] => nodeExecPins(nodes.get(node)!, typeOf(node))
  const inbound = inboundEdges(definition.edges)
  // guard 与类型推断都沿同一个拓扑序自上而下求解，因此只排一次。
  const levels = topologicalLevels(definition.nodes, definition.edges).levels
  const guards = computeGuards(levels, typeOf, pinsOf, inbound)
  const outputTypes = inferOutputTypes(levels, typeOf, inbound)

  const diagnostics: WorkflowDiagnostic[] = []
  for (const edge of definition.edges) {
    if (isDataEdge(edge)) diagnostics.push(...checkDataEdge(edge, { typeOf, guards, outputTypes, nodes }))
  }
  for (const node of definition.nodes) {
    if (typeOf(node.id).execKind === 'join') {
      diagnostics.push(...checkJoin(node.id, guards, typeOf, pinsOf, inbound.data.get(node.id) ?? []))
    }
  }
  return { order: levels.flat(), guards, diagnostics }
}

/**
 * 按拓扑序求每个节点的条件引脚集合。
 *
 * 只有声明了多个执行输出引脚的节点会引入条件：单引脚节点完成时必然触发它，因此不改变下游的依赖。
 * 普通节点是 AND 连接，guard 取各入边之并；OR 连接点只需任一入边触发，因此取各入边之交。
 */
function computeGuards(
  levels: readonly (readonly DagNodeDefinition[])[],
  typeOf: (node: NodeId) => NodeTypeSummary,
  pinsOf: (node: NodeId) => readonly string[],
  inbound: ReturnType<typeof inboundEdges>,
): ReadonlyMap<NodeId, Guard> {
  const guards = new Map<NodeId, Guard>()
  for (const level of levels) {
    for (const node of level) {
      const execEdges = inbound.exec.get(node.id) ?? []
      const reached = execEdges.map((edge) => {
        const pins = new Set(guards.get(edge.source)!)
        if (pinsOf(edge.source).length > 1) {
          pins.add(pinAtom(edge.source, execSourcePin(edge)))
        }
        return pins
      })
      guards.set(node.id, typeOf(node.id).execKind === 'join' ? intersect(reached) : union(reached))
    }
  }
  return guards
}

function union(sets: readonly Guard[]): Guard {
  const result = new Set<string>()
  for (const set of sets) for (const atom of set) result.add(atom)
  return result
}

function intersect(sets: readonly Guard[]): Guard {
  const [first, ...rest] = sets
  if (first === undefined) return new Set()
  return new Set([...first].filter(atom => rest.every(set => set.has(atom))))
}

/**
 * 推断每个节点各输出端口产出的类型。
 *
 * 只有透传型节点的输出类型不等于它声明的类型：`outputType: 'same'` 的可变输入节点把送达的输入原样送出，
 * 因此它声明的 `any` 在实际接线上可以收窄。其余节点的输出类型就是端口声明。
 */
function inferOutputTypes(
  levels: readonly (readonly DagNodeDefinition[])[],
  typeOf: (node: NodeId) => NodeTypeSummary,
  inbound: ReturnType<typeof inboundEdges>,
): ReadonlyMap<NodeId, ReadonlyMap<string, PortType>> {
  const inferred = new Map<NodeId, ReadonlyMap<string, PortType>>()
  const portTypeOf = (edge: DagDataEdge): PortType => {
    const ports = inferred.get(edge.source)
    return ports?.get(edge.sourcePort ?? 'output') ?? 'any'
  }
  for (const level of levels) {
    for (const node of level) {
      const summary = typeOf(node.id)
      const declared = node.outputs ?? summary.outputs
      const passthrough = summary.variadicInputs?.outputType === 'same'
        ? joinTypes((inbound.data.get(node.id) ?? []).map(portTypeOf))
        : undefined
      inferred.set(node.id, new Map(declared.map(port => [
        port.name,
        passthrough !== undefined && port.type === 'any' ? passthrough : port.type,
      ])))
    }
  }
  return inferred
}

/** 多个来源共同确定的类型：全部相同时为该类型，否则无法收窄。 */
function joinTypes(types: readonly PortType[]): PortType {
  const [first, ...rest] = types
  if (first === undefined) return 'any'
  return rest.every(type => type === first) ? first : 'any'
}

interface EdgeContext {
  readonly typeOf: (node: NodeId) => NodeTypeSummary
  readonly guards: ReadonlyMap<NodeId, Guard>
  readonly outputTypes: ReadonlyMap<NodeId, ReadonlyMap<string, PortType>>
  readonly nodes: ReadonlyMap<NodeId, DagNodeDefinition>
}

/**
 * 检查一条数据边：源是否在目标执行时必然执行过，以及产出类型是否与端口声明相符。
 *
 * 源可能被跳过时，必需输入端口会让目标带着缺失的输入执行并失败，因此是错误；
 * 可选输入端口上的同一事实只对工作流输出有意义——该端口在部分分支下收不到值。
 * 分支合并的输入同样可选，但它要求恰好一个送达，由 {@link checkJoin} 单独判断。
 *
 * 类型只在推断收窄了声明时判断：源端口声明为具体类型时，边的类型兼容已由逐条校验和浏览器连线规则拒绝，
 * 再报一次只会让同一个事实有两处来源。
 */
function checkDataEdge(edge: DagDataEdge, context: EdgeContext): WorkflowDiagnostic[] {
  const { typeOf, guards, outputTypes, nodes } = context
  const diagnostics: WorkflowDiagnostic[] = []
  const target = nodes.get(edge.target)!
  const portName = edge.targetPort ?? 'input'
  const port = (target.inputs ?? typeOf(edge.target).inputs).find(item => item.name === portName)!

  const unmet = [...guards.get(edge.source)!].find(atom => !guards.get(edge.target)!.has(atom))
  const code = unmet === undefined
    ? undefined
    : port.required !== false
      ? 'starved-input' as const
      : target.type === WORKFLOW_OUTPUT_TYPE ? 'output-gap' as const : undefined
  if (code !== undefined) {
    diagnostics.push({
      code,
      nodeId: edge.target,
      edgeId: edge.id,
      sourceId: edge.source,
      port: portName,
      pin: formatAtom(unmet!),
    })
  }

  const sourcePort = edge.sourcePort ?? 'output'
  const source = nodes.get(edge.source)!
  const declared = (source.outputs ?? typeOf(edge.source).outputs).find(item => item.name === sourcePort)!
  const produced = outputTypes.get(edge.source)!.get(sourcePort)!
  if (declared.type === 'any' && produced !== 'any' && port.type !== 'any' && produced !== port.type) {
    diagnostics.push({
      code: 'type-mismatch',
      nodeId: edge.target,
      edgeId: edge.id,
      port: portName,
      types: [produced, port.type],
    })
  }
  return diagnostics
}

/**
 * 检查一个 OR 连接点的数据源恰好有一个送达。
 *
 * 没有数据源的连接点只汇合执行流，没有值要送达，这里无话可说。
 * 否则把每个源的 guard 减去连接点自身的 guard，剩下的就是该源相对于连接点多出的条件。
 * 两个剩余条件包含同一决策节点的不同引脚时它们互斥，任何一次运行至多命中一个；
 * 全部剩余条件覆盖某个决策节点的每个引脚时至少命中一个。两者都成立才是恰好一个。
 */
function checkJoin(
  node: NodeId,
  guards: ReadonlyMap<NodeId, Guard>,
  typeOf: (node: NodeId) => NodeTypeSummary,
  pinsOf: (node: NodeId) => readonly string[],
  sources: readonly DagDataEdge[],
): WorkflowDiagnostic[] {
  if (sources.length === 0) return []
  const own = guards.get(node)!
  const remainders = sources.map(edge => new Set([...guards.get(edge.source)!].filter(atom => !own.has(atom))))
  const isDecision = (atom: string): boolean => typeOf(atomNode(atom)).execKind === 'decision'
  const diagnostics: WorkflowDiagnostic[] = []

  for (const [index, remainder] of remainders.entries()) {
    const overlap = remainders.findIndex((other, position) =>
      position > index && !excludes(remainder, other, isDecision))
    if (overlap >= 0) {
      diagnostics.push({
        code: 'merge-overlap',
        nodeId: node,
        sources: [sources[index]!.source, sources[overlap]!.source],
      })
    }
  }
  if (!covers(remainders, pinsOf, isDecision)) {
    diagnostics.push({ code: 'merge-gap', nodeId: node })
  }
  return diagnostics
}

/** 两个条件集合是否互斥：依赖同一决策节点的不同引脚。 */
function excludes(a: Guard, b: Guard, isDecision: (atom: string) => boolean): boolean {
  return [...a].some(atom => isDecision(atom)
    && !b.has(atom)
    && [...b].some(other => atomNode(other) === atomNode(atom)))
}

/**
 * 条件集合是否覆盖所有分支：任何一次运行都至少命中其中一个。
 *
 * 空条件必然命中。否则取任一决策节点，逐个假设它的每个引脚触发：丢弃依赖它其他引脚的集合，
 * 从其余集合中划去该引脚，递归判断剩下的条件。每层都消去一个决策节点，因此递归必然结束。
 */
function covers(
  remainders: readonly Guard[],
  pinsOf: (node: NodeId) => readonly string[],
  isDecision: (atom: string) => boolean,
): boolean {
  if (remainders.some(remainder => remainder.size === 0)) return true
  const chosen = remainders.flatMap(remainder => [...remainder]).find(isDecision)
  if (chosen === undefined) return false
  const decision = atomNode(chosen)
  return pinsOf(decision).every((pin) => {
    const atom = pinAtom(decision, pin)
    return covers(
      remainders
        .filter(remainder => [...remainder].every(item => atomNode(item) !== decision || item === atom))
        .map(remainder => new Set([...remainder].filter(item => item !== atom))),
      pinsOf,
      isDecision,
    )
  })
}

/**
 * 按类型名索引节点目录。
 * @param nodeTypes - 注册表或快照给出的节点类型。
 */
export function indexNodeTypes(nodeTypes: readonly NodeTypeSummary[]): ReadonlyMap<string, NodeTypeSummary> {
  return new Map(nodeTypes.map(nodeType => [nodeType.type, nodeType]))
}
