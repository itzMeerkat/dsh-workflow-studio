/**
 * 工作流定义验证：按节点注册表检查节点、端口、边和拓扑顺序。
 * @module dsh-workflow-studio
 */

import {
  assertUniquePortNames,
  execOutputPins,
  execPinFault,
  execSourcePin,
  execTargetPin,
  inboundEdges,
  isDataEdge,
  isExecEdge,
  portsAreCompatible,
  resolveInputPorts,
  topologicalLevels,
} from './shared/graph.ts'
import { isAnyJoin } from './flow-nodes.ts'
import { WORKFLOW_INPUT_TYPE, WORKFLOW_OUTPUT_TYPE } from './shared/workflow-boundary.ts'
import type { WorkflowNodeRegistry } from './registry.ts'
import type {
  DagDataEdge, DagExecEdge, DagNodeDefinition, DagWorkflowDefinition, NodeId, PortDefinition,
  WorkflowNodeExecutor,
} from './shared/types.ts'

/**
 * 按拓扑层级返回节点。层级表示依赖深度，供校验和编辑器展示；调度按每个节点自身的前驱进行。
 * @param definition - 工作流定义。
 * @returns 按依赖深度排列的层级。
 * @throws 工作流包含环或边引用不存在的节点时。
 */
export function topologicalSort(definition: DagWorkflowDefinition): DagNodeDefinition[][] {
  const { levels, cyclic } = topologicalLevels(definition.nodes, definition.edges)
  if (cyclic.length > 0) throw new Error(`工作流包含环：${cyclic.map(node => node.id).join(', ')}`)
  return levels
}

/**
 * 按注册表验证一个作者保存的定义。
 *
 * 边界节点是普通节点，因此端口、边和拓扑校验对它们一视同仁；这里只多一条它们独有的规则。
 * @param registry - 提供节点类型的注册表。
 * @param definition - 待验证的定义。
 * @throws 定义违反任一可由注册表确定的不变量时。
 */
export function validateWorkflow(registry: WorkflowNodeRegistry, definition: DagWorkflowDefinition): void {
  assertSingleBoundary(definition, WORKFLOW_INPUT_TYPE, '输入')
  assertSingleBoundary(definition, WORKFLOW_OUTPUT_TYPE, '输出')
  resolveExecutors(registry, definition)
}

/**
 * 一个工作流最多只有一个该侧的边界节点。
 *
 * 工作流的签名就是边界节点声明的端口，两个同侧边界节点会让签名无从谈起。
 * @param definition - 待验证的定义。
 * @param type - 边界节点类型。
 * @param kind - 端口所在的一侧，用于错误信息。
 * @throws 存在多个该侧边界节点时。
 */
function assertSingleBoundary(definition: DagWorkflowDefinition, type: string, kind: string): void {
  if (definition.nodes.filter(node => node.type === type).length > 1) {
    throw new Error(`工作流最多只能有一个${kind}边界节点`)
  }
}

interface ResolvedNodePorts {
  inputs: readonly PortDefinition[]
  outputs: readonly PortDefinition[]
}

/**
 * 按注册表验证定义，并解析每个节点的执行器。
 * @param registry - 提供节点类型的注册表。
 * @param definition - 待验证的定义。
 * @returns 节点 ID 到执行器的映射。
 * @throws 定义违反任一可由注册表确定的不变量时。
 */
export function resolveExecutors(
  registry: WorkflowNodeRegistry,
  definition: DagWorkflowDefinition,
): Map<NodeId, WorkflowNodeExecutor> {
  const executors = new Map<NodeId, WorkflowNodeExecutor>()
  const nodePorts = new Map<NodeId, ResolvedNodePorts>()
  for (const node of definition.nodes) {
    if (nodePorts.has(node.id)) throw new Error(`节点 ID "${node.id}" 重复`)

    const executor = registry.get(node.type)
    if (executor === undefined) throw new Error(`未知节点类型: ${node.type}`)
    const inputs = resolveInputPorts(node.inputs, executor.inputs ?? [])
    const outputs = node.outputs ?? executor.outputs ?? []
    assertUniquePortNames(`节点 ${node.id}`, '输入', inputs)
    assertUniquePortNames(`节点 ${node.id}`, '输出', outputs)
    validateVariadicInputs(node, executor, inputs, outputs)
    executors.set(node.id, executor)
    nodePorts.set(node.id, { inputs, outputs })
  }

  const edgeIds = new Set<string>()
  const connectedInputs = new Set<string>()
  const execEdgeKeys = new Set<string>()
  for (const edge of definition.edges) {
    if (edgeIds.has(edge.id)) throw new Error(`边 ID "${edge.id}" 重复`)
    edgeIds.add(edge.id)

    const source = nodePorts.get(edge.source)
    if (source === undefined) throw new Error(`边 ${edge.id} 引用不存在的源节点 ${edge.source}`)
    const target = nodePorts.get(edge.target)
    if (target === undefined) throw new Error(`边 ${edge.id} 引用不存在的目标节点 ${edge.target}`)

    if (isExecEdge(edge)) {
      validateExecEdge(edge, executors.get(edge.source)!, execEdgeKeys)
      continue
    }
    validateDataEdge(edge, source, target, connectedInputs)
  }

  for (const [nodeId, ports] of nodePorts) {
    for (const port of ports.inputs) {
      if (port.required !== false && !connectedInputs.has(`${nodeId}\u0000${port.name}`)) {
        throw new Error(`节点 ${nodeId} 的输入端口 ${port.name} 缺少入边`)
      }
    }
  }

  assertNoStarvedInputs(definition, executors, nodePorts)
  return executors
}

/** 节点执行所依赖的条件引脚集合；空集表示节点在运行到达时必然执行。 */
type Guard = ReadonlySet<string>

/**
 * 拒绝目标可能在源被跳过时仍然执行的数据边。
 *
 * 跳过只沿执行边传递，因此这种接线会让目标带着缺失的必需输入执行并失败。
 * 对每个节点求出它执行所依赖的条件引脚集合 `guard`：只有 `guard(源) ⊆ guard(目标)` 时，
 * 目标执行就意味着源也执行过。无法证明时拒绝，作者补一条执行边即可。
 * @param definition - 已通过边校验的定义。
 * @param executors - 节点 ID 到执行器的映射。
 * @param nodePorts - 节点 ID 到已解析端口的映射。
 * @throws 存在可能缺失必需输入的数据边时。
 */
function assertNoStarvedInputs(
  definition: DagWorkflowDefinition,
  executors: ReadonlyMap<NodeId, WorkflowNodeExecutor>,
  nodePorts: ReadonlyMap<NodeId, ResolvedNodePorts>,
): void {
  const inbound = inboundEdges(definition.edges)
  const guards = new Map<NodeId, Guard>()
  for (const level of topologicalSort(definition)) {
    for (const node of level) {
      const execEdges = inbound.exec.get(node.id) ?? []
      if (execEdges.length === 0) {
        guards.set(node.id, new Set())
        continue
      }
      const reached = execEdges.map((edge) => {
        const pins = new Set(guards.get(edge.source) ?? [])
        // A source with one execution pin always fires it when it completes, so it adds no condition.
        if (execOutputPins(executors.get(edge.source)!).length > 1) {
          pins.add(`${edge.source}\u0000${execSourcePin(edge)}`)
        }
        return pins
      })
      const executor = executors.get(node.id)!
      guards.set(node.id, isAnyJoin(executor) ? intersect(reached) : union(reached))
    }
  }

  for (const edge of definition.edges) {
    if (!isDataEdge(edge)) continue
    const targetPort = edge.targetPort ?? 'input'
    const port = nodePorts.get(edge.target)!.inputs.find(item => item.name === targetPort)
    if (port?.required === false) continue
    const sourceGuard = guards.get(edge.source)!
    const targetGuard = guards.get(edge.target)!
    const unmet = [...sourceGuard].find(pin => !targetGuard.has(pin))
    if (unmet === undefined) continue
    const [nodeId, pin] = unmet.split('\u0000')
    throw new Error(
      `边 ${edge.id} 的源节点 ${edge.source} 可能被跳过，而目标节点 ${edge.target} 仍会执行`
      + `（${edge.target} 不依赖 ${nodeId}.${pin} 触发）：为 ${edge.target} 补一条执行边，`
      + `或把输入端口 ${targetPort} 声明为可选`,
    )
  }
}

function union(sets: readonly Guard[]): Guard {
  const result = new Set<string>()
  for (const set of sets) for (const item of set) result.add(item)
  return result
}

function intersect(sets: readonly Guard[]): Guard {
  const [first, ...rest] = sets
  if (first === undefined) return new Set()
  return new Set([...first].filter(item => rest.every(set => set.has(item))))
}

/**
 * 校验一条执行边的引脚，并拒绝同一对引脚之间的重复边。
 *
 * 引脚规则由 {@link execPinFault} 与浏览器连线共用；此处只把不成立的一端翻译成错误信息。
 * @param edge - 待校验的执行边。
 * @param source - 源节点的执行器。
 * @param seen - 已出现的 `源/源引脚/目标/目标引脚` 组合，就地记录。
 * @throws 引脚不存在或组合重复时。
 */
function validateExecEdge(edge: DagExecEdge, source: WorkflowNodeExecutor, seen: Set<string>): void {
  const sourcePin = execSourcePin(edge)
  const targetPin = execTargetPin(edge)
  const fault = execPinFault(execOutputPins(source), sourcePin, targetPin)
  if (fault === 'source') {
    throw new Error(`执行边 ${edge.id} 引用节点 ${edge.source} 不存在的执行输出引脚 ${sourcePin}`)
  }
  if (fault === 'target') {
    throw new Error(`执行边 ${edge.id} 引用节点 ${edge.target} 不存在的执行输入引脚 ${targetPin}`)
  }
  const key = `${edge.source}\u0000${sourcePin}\u0000${edge.target}\u0000${targetPin}`
  if (seen.has(key)) {
    throw new Error(`执行边 ${edge.id} 与已有的 ${edge.source}.${sourcePin} -> ${edge.target}.${targetPin} 重复`)
  }
  seen.add(key)
}

/**
 * 校验一条数据边的端口存在、类型兼容，且目标输入端口只有一条入边。
 * @param edge - 待校验的数据边。
 * @param source - 源节点的已解析端口。
 * @param target - 目标节点的已解析端口。
 * @param connectedInputs - 已连接的 `节点/输入端口` 组合，就地记录。
 * @throws 端口不存在、类型不兼容或输入端口重复连接时。
 */
function validateDataEdge(
  edge: DagDataEdge,
  source: ResolvedNodePorts,
  target: ResolvedNodePorts,
  connectedInputs: Set<string>,
): void {
  const sourcePort = edge.sourcePort ?? 'output'
  const targetPort = edge.targetPort ?? 'input'
  const sourceDefinition = source.outputs.find(port => port.name === sourcePort)
  if (sourceDefinition === undefined) {
    throw new Error(`边 ${edge.id} 引用节点 ${edge.source} 不存在的输出端口 ${sourcePort}`)
  }
  const targetDefinition = target.inputs.find(port => port.name === targetPort)
  if (targetDefinition === undefined) {
    throw new Error(`边 ${edge.id} 引用节点 ${edge.target} 不存在的输入端口 ${targetPort}`)
  }
  if (!portsAreCompatible(sourceDefinition, targetDefinition)) {
    throw new Error(
      `边 ${edge.id} 的端口类型不兼容: ${edge.source}.${sourcePort}`
      + ` (${sourceDefinition.type}) -> ${edge.target}.${targetPort} (${targetDefinition.type})`,
    )
  }

  const inputKey = `${edge.target}\u0000${targetPort}`
  if (connectedInputs.has(inputKey)) {
    throw new Error(`节点 ${edge.target} 的输入端口 ${targetPort} 存在多条入边`)
  }
  connectedInputs.add(inputKey)
}

function validateVariadicInputs(
  node: DagNodeDefinition,
  executor: WorkflowNodeExecutor,
  inputs: readonly PortDefinition[],
  outputs: readonly PortDefinition[],
): void {
  const constraint = executor.variadicInputs
  if (constraint === undefined) return
  if (inputs.length < constraint.min) {
    throw new Error(`节点 ${node.id} 至少需要 ${constraint.min} 个输入端口`)
  }
  const inputType = inputs[0]?.type
  if (inputs.some(port => port.type !== inputType)) {
    throw new Error(`节点 ${node.id} 的所有输入端口必须使用相同类型`)
  }
  if (constraint.outputType === 'same'
    && (outputs.length !== 1 || outputs[0]?.type !== inputType)) {
    throw new Error(`节点 ${node.id} 的输出端口必须与输入端口使用相同类型`)
  }
}
