/**
 * 子工作流：把另一个同种类的已保存工作流当作一个节点。
 *
 * 节点只记下被嵌入工作流的 ID，是链接而不是副本：它的端口就是那个工作流的签名，改动那个工作流就改动每个嵌入它的地方。
 * `run` 工作流在运行开始时把它展开成那个工作流的节点；`code` 工作流把它写成对那个工作流生成的函数的调用。
 * @module dsh-workflow-studio
 */

import type { Signature } from './language.ts'
import { WorkflowId, type DagWorkflowDefinition } from './types.ts'
import { workflowInputPorts, workflowOutputPorts } from './workflow-boundary.ts'

/** 嵌入另一个工作流的节点类型。 */
export const SUBWORKFLOW_TYPE = 'subworkflow'

/** 子工作流节点存放被嵌入工作流 ID 的配置字段。 */
export const SUBWORKFLOW_FIELD = 'workflow'

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
 * 一个工作流作为节点时的签名：输入是参数，输出是结果。
 *
 * `run` 工作流的输入有默认值时可以不接线；`code` 工作流从不运行，输入没有默认值可用，因此都必须接线。
 * @param definition - 被嵌入的工作流。
 * @returns 以工作流名称命名的签名。
 */
export function workflowSignature(definition: DagWorkflowDefinition): Signature & { readonly name: string } {
  return {
    name: definition.name,
    parameters: workflowInputPorts(definition).map(({ name, type, default: value }) =>
      ({ name, type, optional: definition.kind === 'run' && value !== undefined })),
    results: workflowOutputPorts(definition).map(({ name, type }) => ({ name, type })),
  }
}

/**
 * 一个工作流为什么不能嵌入另一个。
 * - `other-kind`：两者种类不同。
 * - `no-calls`：`code` 工作流的语言写不出函数调用。
 * - `other-package`：`code` 工作流按名字调用被嵌入工作流生成的函数，所以两者必须是同一语言、同一原子目录。
 * - `cycle`：被嵌入的工作流直接或间接嵌入了嵌入它的工作流。
 */
export type EmbedFault = 'other-kind' | 'no-calls' | 'other-package' | 'cycle'

/**
 * 判断 `child` 能否嵌入 `parent`。
 * @param parent - 嵌入方。
 * @param parentId - 嵌入方的 ID；尚未保存的工作流没有 ID，也就不会被任何工作流嵌入。
 * @param childId - 被嵌入的工作流的 ID。
 * @param child - 被嵌入的工作流。
 * @param lookup - 读取已保存的工作流，用于沿嵌入关系查找环。
 * @param callable - `parent` 的语言能否写出函数调用；只对 `code` 工作流有意义。
 * @returns 不能嵌入的原因；能嵌入时为 undefined。
 */
export function embedFault(
  parent: DagWorkflowDefinition,
  parentId: WorkflowId | undefined,
  childId: WorkflowId,
  child: DagWorkflowDefinition,
  lookup: WorkflowLookup,
  callable: boolean,
): EmbedFault | undefined {
  if (child.kind !== parent.kind) return 'other-kind'
  if (parent.kind === 'code' && !callable) return 'no-calls'
  if (parent.kind === 'code' && (child.language !== parent.language || child.atomFolder !== parent.atomFolder)) {
    return 'other-package'
  }
  if (parentId !== undefined && (childId === parentId || embeds(child, parentId, lookup))) return 'cycle'
  return undefined
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
