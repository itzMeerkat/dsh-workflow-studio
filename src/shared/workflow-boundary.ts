/**
 * 工作流的输入输出边界节点。
 *
 * 边界由两个普通节点承担：`workflow-input` 节点声明的输出端口就是工作流接受的输入，
 * `workflow-output` 节点声明的输入端口就是工作流产出的输出。端口、坐标、边、校验和运行记录
 * 因此全部走节点已有的规则，而工作流的签名从图中读出。
 * @module dsh-workflow-studio
 */

import type { DagNodeDefinition, DagWorkflowDefinition, JsonObject, PortDefinition } from './types.ts'

/** 把调用方提供的输入送入图中的节点类型。 */
export const WORKFLOW_INPUT_TYPE = 'workflow-input'

/** 收集工作流输出的节点类型。 */
export const WORKFLOW_OUTPUT_TYPE = 'workflow-output'

/** 运行为输入边界节点准备的值所在的配置字段。 */
export const WORKFLOW_INPUT_VALUES = 'values'

/**
 * 工作流的输入边界节点。
 * @param definition - 工作流定义。
 * @returns 该节点；工作流不接受输入时为 undefined。
 */
export function workflowInputNode(definition: DagWorkflowDefinition): DagNodeDefinition | undefined {
  return definition.nodes.find(node => node.type === WORKFLOW_INPUT_TYPE)
}

/**
 * 工作流的输出边界节点。
 * @param definition - 工作流定义。
 * @returns 该节点；工作流不产出输出时为 undefined。
 */
export function workflowOutputNode(definition: DagWorkflowDefinition): DagNodeDefinition | undefined {
  return definition.nodes.find(node => node.type === WORKFLOW_OUTPUT_TYPE)
}

/**
 * 工作流接受的输入端口，即输入边界节点声明的输出端口。
 * @param definition - 工作流定义。
 * @returns 声明的输入端口，按声明顺序。
 */
export function workflowInputPorts(definition: DagWorkflowDefinition): readonly PortDefinition[] {
  return workflowInputNode(definition)?.outputs ?? []
}

/**
 * 工作流产出的输出端口，即输出边界节点声明的输入端口。
 * @param definition - 工作流定义。
 * @returns 声明的输出端口，按声明顺序。
 */
export function workflowOutputPorts(definition: DagWorkflowDefinition): readonly PortDefinition[] {
  return workflowOutputNode(definition)?.inputs ?? []
}

/**
 * 带上本次运行输入值的定义。
 *
 * 值放在输入边界节点的配置里，因此运行快照自带这些值，恢复和运行记录都不必另行传递。
 * @param definition - 已保存的定义。
 * @param supplied - 调用方提供的值。
 * @returns 供本次运行调度的定义。
 * @throws 提供了工作流未声明的输入，或某个没有默认值的输入未被提供时。
 */
export function withRunInputs(
  definition: DagWorkflowDefinition,
  supplied: JsonObject,
): DagWorkflowDefinition {
  const node = workflowInputNode(definition)
  if (node === undefined) {
    const [unknown] = Object.keys(supplied)
    if (unknown !== undefined) throw new Error(`工作流未声明输入 "${unknown}"`)
    return definition
  }
  const values = resolveWorkflowInputs(node.outputs ?? [], supplied)
  return {
    ...definition,
    nodes: definition.nodes.map(item => item.id === node.id
      ? { ...item, config: { ...item.config, [WORKFLOW_INPUT_VALUES]: values } }
      : item),
  }
}

/**
 * 每个声明输入端口在本次运行中的值。
 *
 * 缺失的输入在运行开始前就失败，因此输入边界节点执行时每个端口都有值。
 * @param ports - 输入边界节点声明的输出端口。
 * @param supplied - 调用方提供的值。
 * @returns 每个声明端口一个值。
 * @throws 提供了未声明的输入，或某个既未提供又没有默认值的输入缺失时。
 */
export function resolveWorkflowInputs(
  ports: readonly PortDefinition[],
  supplied: JsonObject,
): JsonObject {
  const declared = new Set(ports.map(port => port.name))
  const unknown = Object.keys(supplied).find(name => !declared.has(name))
  if (unknown !== undefined) {
    throw new Error(`工作流未声明输入 "${unknown}"`)
  }
  const values: JsonObject = {}
  for (const port of ports) {
    if (Object.hasOwn(supplied, port.name)) {
      values[port.name] = supplied[port.name]!
      continue
    }
    if (port.default === undefined) {
      throw new Error(`工作流输入 "${port.name}" 未提供值，且没有默认值`)
    }
    values[port.name] = port.default
  }
  return values
}

/**
 * 一个节点是否为边界节点。
 * @param node - 待判断的节点。
 */
export function isBoundaryNode(node: DagNodeDefinition): boolean {
  return node.type === WORKFLOW_INPUT_TYPE || node.type === WORKFLOW_OUTPUT_TYPE
}

/**
 * 一个边界节点声明的是工作流的哪一侧端口。
 * @param node - 边界节点。
 * @returns 输入边界为 `inputs`，输出边界为 `outputs`。
 */
export function boundarySide(node: DagNodeDefinition): 'inputs' | 'outputs' {
  return node.type === WORKFLOW_INPUT_TYPE ? 'inputs' : 'outputs'
}

/**
 * 一个边界节点声明的工作流端口。
 *
 * 工作流的输入是输入边界节点的输出端口，反之亦然：方向按图中的数据流向，而不是按工作流签名。
 * @param node - 边界节点。
 * @returns 声明的端口，按声明顺序。
 */
export function boundaryPorts(node: DagNodeDefinition): readonly PortDefinition[] {
  return (node.type === WORKFLOW_INPUT_TYPE ? node.outputs : node.inputs) ?? []
}

/**
 * 替换一个边界节点声明的工作流端口。
 * @param node - 边界节点。
 * @param ports - 新的端口列表。
 * @returns 新的节点定义。
 */
export function withBoundaryPorts(
  node: DagNodeDefinition,
  ports: readonly PortDefinition[],
): DagNodeDefinition {
  return node.type === WORKFLOW_INPUT_TYPE
    ? { ...node, outputs: [...ports] }
    : { ...node, inputs: [...ports] }
}
