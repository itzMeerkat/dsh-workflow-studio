/**
 * 工作流定义验证：按节点注册表检查节点、端口、边和拓扑顺序。
 * @module dsh-workflow-studio
 */

import { DIAGNOSTIC_SEVERITY, analyzeWorkflow, indexNodeTypes } from './shared/analysis.ts'
import {
  duplicatePortName,
  execPinFault,
  execSourcePin,
  execTargetPin,
  isExecEdge,
  nodeExecPins,
  portsAreCompatible,
  topologicalLevels,
} from './shared/graph.ts'
import { isAbsolute } from 'node:path'
import { languageOf } from './shared/language.ts'
import { SWITCH_TYPE, invalidCase, switchCases } from './shared/switch.ts'
import { DEFAULT_WORKFLOW_KIND } from './shared/types.ts'
import { WORKFLOW_INPUT_TYPE, WORKFLOW_OUTPUT_TYPE } from './shared/workflow-boundary.ts'
import type { WorkflowNodeRegistry } from './registry.ts'
import type {
  DagDataEdge, DagExecEdge, DagNodeDefinition, DagWorkflowDefinition, NodeId, PortDefinition,
  WorkflowNodeExecutor,
} from './shared/types.ts'
import { refuse } from './shared/refusal.ts'

/**
 * 按拓扑层级返回节点。层级表示依赖深度，供校验和编辑器展示；调度按每个节点自身的前驱进行。
 * @param definition - 工作流定义。
 * @returns 按依赖深度排列的层级。
 * @throws 工作流包含环或边引用不存在的节点时。
 */
export function topologicalSort(definition: DagWorkflowDefinition): DagNodeDefinition[][] {
  const { levels, cyclic } = topologicalLevels(definition.nodes, definition.edges)
  if (cyclic.length > 0) refuse({ code: 'cycle', nodes: cyclic.map(node => node.id) })
  return levels
}

/**
 * 按注册表验证一个作者保存的定义。
 *
 * 边界节点是普通节点，因此端口、边和拓扑校验对它们一视同仁；这里只多一条它们独有的规则，
 * 以及每个节点类型都属于工作流的种类、`code` 工作流必须指定一种语言、原子目录必须是能读原子的语言中的绝对路径。
 * 种类只约束作者放置的节点；运行开始时展开子工作流放置的节点不属于任何种类，所以 {@link resolveExecutors} 不查它。
 * @param registry - 提供节点类型的注册表。
 * @param definition - 待验证的定义。
 * @throws 定义违反任一可由注册表确定的不变量时。
 */
export function validateWorkflow(registry: WorkflowNodeRegistry, definition: DagWorkflowDefinition): void {
  const language = languageOf(definition)
  if (definition.atomFolder !== undefined && (language.functions?.atoms === undefined || !isAbsolute(definition.atomFolder))) {
    refuse({ code: 'atom-folder-invalid', folder: definition.atomFolder })
  }
  assertSingleBoundary(definition, WORKFLOW_INPUT_TYPE, 'inputs')
  assertSingleBoundary(definition, WORKFLOW_OUTPUT_TYPE, 'outputs')
  const executors = resolveExecutors(registry, definition)
  for (const node of definition.nodes) {
    const kinds = executors.get(node.id)!.kinds ?? [DEFAULT_WORKFLOW_KIND]
    if (!kinds.includes(definition.kind)) {
      refuse({ code: 'node-kind', type: node.type, kinds, kind: definition.kind })
    }
  }
}

/**
 * 一个工作流最多只有一个该侧的边界节点。
 *
 * 工作流的签名就是边界节点声明的端口，两个同侧边界节点会让签名无从谈起。
 * @param definition - 待验证的定义。
 * @param type - 边界节点类型。
 * @param side - 边界节点承担的一侧。
 * @throws 存在多个该侧边界节点时。
 */
function assertSingleBoundary(definition: DagWorkflowDefinition, type: string, side: 'inputs' | 'outputs'): void {
  if (definition.nodes.filter(node => node.type === type).length > 1) {
    refuse({ code: 'boundary-duplicate', side })
  }
}

interface ResolvedNodePorts {
  inputs: readonly PortDefinition[]
  outputs: readonly PortDefinition[]
  execPins: readonly string[]
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
    if (nodePorts.has(node.id)) refuse({ code: 'node-duplicate', node: node.id })

    const executor = registry.get(node.type)
    if (executor === undefined) refuse({ code: 'node-type-unknown', type: node.type })
    const inputs = node.inputs ?? executor.inputs ?? []
    const outputs = node.outputs ?? executor.outputs ?? []
    for (const [side, ports] of [['inputs', inputs], ['outputs', outputs]] as const) {
      const duplicate = duplicatePortName(ports)
      if (duplicate !== undefined) refuse({ code: 'port-duplicate', node: node.id, side, port: duplicate })
    }
    validateVariadicInputs(node, executor, inputs, outputs)
    // case 就是执行引脚的名字，所以它们与端口名一样必须互不相同。
    const invalid = node.type === SWITCH_TYPE ? invalidCase(switchCases(node.config)) : undefined
    if (invalid !== undefined) refuse({ code: 'switch-case', node: node.id, case: invalid })
    executors.set(node.id, executor)
    nodePorts.set(node.id, { inputs, outputs, execPins: nodeExecPins(node, executor) })
  }

  const edgeIds = new Set<string>()
  const connectedInputs = new Set<string>()
  const execEdgeKeys = new Set<string>()
  for (const edge of definition.edges) {
    if (edgeIds.has(edge.id)) refuse({ code: 'edge-duplicate', edge: edge.id })
    edgeIds.add(edge.id)

    const source = nodePorts.get(edge.source)
    if (source === undefined) refuse({ code: 'edge-node-missing', edge: edge.id, end: 'source', node: edge.source })
    const target = nodePorts.get(edge.target)
    if (target === undefined) refuse({ code: 'edge-node-missing', edge: edge.id, end: 'target', node: edge.target })

    if (isExecEdge(edge)) {
      validateExecEdge(edge, source.execPins, execEdgeKeys)
      continue
    }
    validateDataEdge(edge, source, target, connectedInputs)
  }

  for (const [nodeId, ports] of nodePorts) {
    for (const port of ports.inputs) {
      if (port.required !== false && !connectedInputs.has(`${nodeId}\u0000${port.name}`)) {
        refuse({ code: 'input-unwired', node: nodeId, port: port.name })
      }
    }
  }

  assertNoAnalysisErrors(registry, definition)
  return executors
}

/**
 * 按整图分析拒绝在任何分支下都错误的接线。
 *
 * 逐条规则看不到跨分支的可达性：只有整张图能回答"目标执行时源是否必然执行过"。
 * 告警由保存结果带回给作者，不阻止保存，因为分析不知道运行期会选哪条分支。
 * @param registry - 提供节点类型的注册表。
 * @param definition - 已通过逐条规则校验的定义。
 * @returns 分析给出的全部告警。
 * @throws 定义包含环，或存在严重程度为 error 的诊断时。
 */
function assertNoAnalysisErrors(registry: WorkflowNodeRegistry, definition: DagWorkflowDefinition): void {
  // 分析按拓扑序求 guard，环上的节点排不进任何层级，因此先在这里拒绝环。
  topologicalSort(definition)
  const { diagnostics } = analyzeWorkflow(definition, indexNodeTypes(registry.listTypes()))
  const error = diagnostics.find(diagnostic => DIAGNOSTIC_SEVERITY[diagnostic.code] === 'error')
  if (error !== undefined) refuse({ code: 'diagnostic', diagnostic: error })
}

/**
 * 校验一条执行边的引脚，并拒绝同一对引脚之间的重复边。
 *
 * 引脚规则由 {@link execPinFault} 与浏览器连线共用；此处只把不成立的一端翻译成错误信息。
 * @param edge - 待校验的执行边。
 * @param sourcePins - 源节点的执行输出引脚。
 * @param seen - 已出现的 `源/源引脚/目标/目标引脚` 组合，就地记录。
 * @throws 引脚不存在或组合重复时。
 */
function validateExecEdge(edge: DagExecEdge, sourcePins: readonly string[], seen: Set<string>): void {
  const sourcePin = execSourcePin(edge)
  const targetPin = execTargetPin(edge)
  const fault = execPinFault(sourcePins, sourcePin, targetPin)
  if (fault === 'source') {
    refuse({ code: 'exec-pin-missing', edge: edge.id, end: 'source', node: edge.source, pin: sourcePin })
  }
  if (fault === 'target') {
    refuse({ code: 'exec-pin-missing', edge: edge.id, end: 'target', node: edge.target, pin: targetPin })
  }
  const key = `${edge.source}\u0000${sourcePin}\u0000${edge.target}\u0000${targetPin}`
  if (seen.has(key)) {
    refuse({ code: 'exec-edge-duplicate', edge: edge.id, source: edge.source, sourcePin, target: edge.target, targetPin })
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
    refuse({ code: 'port-missing', edge: edge.id, side: 'outputs', node: edge.source, port: sourcePort })
  }
  const targetDefinition = target.inputs.find(port => port.name === targetPort)
  if (targetDefinition === undefined) {
    refuse({ code: 'port-missing', edge: edge.id, side: 'inputs', node: edge.target, port: targetPort })
  }
  if (!portsAreCompatible(sourceDefinition, targetDefinition)) {
    refuse({
      code: 'port-incompatible',
      edge: edge.id,
      source: edge.source,
      sourcePort,
      sourceType: sourceDefinition.type,
      target: edge.target,
      targetPort,
      targetType: targetDefinition.type,
    })
  }

  const inputKey = `${edge.target}\u0000${targetPort}`
  if (connectedInputs.has(inputKey)) {
    refuse({ code: 'input-overwired', node: edge.target, port: targetPort })
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
    refuse({ code: 'variadic-min', node: node.id, min: constraint.min })
  }
  const inputType = inputs[0]?.type
  if (inputs.some(port => port.type !== inputType)) {
    refuse({ code: 'variadic-input-type', node: node.id })
  }
  if (constraint.outputType === 'same'
    && (outputs.length !== 1 || outputs[0]?.type !== inputType)) {
    refuse({ code: 'variadic-output-type', node: node.id })
  }
}
