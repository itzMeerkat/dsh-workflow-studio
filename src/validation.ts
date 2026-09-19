/**
 * 工作流定义验证：按节点注册表检查节点、端口、边和拓扑顺序。
 * @module dsh-workflow-studio
 */

import { assertUniquePortNames, portsAreCompatible, resolveInputPorts, topologicalLevels } from './shared/graph.ts'
import type { WorkflowNodeRegistry } from './registry.ts'
import type { DagNodeDefinition, DagWorkflowDefinition, NodeId, PortDefinition, WorkflowNodeExecutor } from './shared/types.ts'

/**
 * 按拓扑层级返回节点，同一层级的节点可并行执行。
 * @param definition - 工作流定义。
 * @returns 按执行顺序排列的层级。
 * @throws 工作流包含环或边引用不存在的节点时。
 */
export function topologicalSort(definition: DagWorkflowDefinition): DagNodeDefinition[][] {
  const { levels, cyclic } = topologicalLevels(definition.nodes, definition.edges)
  if (cyclic.length > 0) throw new Error(`工作流包含环：${cyclic.map(node => node.id).join(', ')}`)
  return levels
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
  for (const edge of definition.edges) {
    if (edgeIds.has(edge.id)) throw new Error(`边 ID "${edge.id}" 重复`)
    edgeIds.add(edge.id)

    const source = nodePorts.get(edge.source)
    if (source === undefined) throw new Error(`边 ${edge.id} 引用不存在的源节点 ${edge.source}`)
    const target = nodePorts.get(edge.target)
    if (target === undefined) throw new Error(`边 ${edge.id} 引用不存在的目标节点 ${edge.target}`)

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

  for (const [nodeId, ports] of nodePorts) {
    for (const port of ports.inputs) {
      if (port.required !== false && !connectedInputs.has(`${nodeId}\u0000${port.name}`)) {
        throw new Error(`节点 ${nodeId} 的输入端口 ${port.name} 缺少入边`)
      }
    }
  }

  topologicalSort(definition)
  return executors
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
