/**
 * 节点的错误策略：节点遇到它自己处理不了的错误时，工作流怎么做。
 *
 * 能处理的错误属于节点内部的业务逻辑，所以到达工作流的错误只按策略处置，图中没有处理错误的分支。
 * @module dsh-workflow-studio
 */

import { calleeSignature, type Callees } from './callees.ts'
import { isBoundaryNode } from './workflow-boundary.ts'
import type { DagNodeDefinition, NodeErrorPolicy, WorkflowKind } from './types.ts'
import { assertNever } from './errors.ts'

/** 全部错误策略，按编辑器中列出的顺序。 */
export const ERROR_POLICIES: readonly NodeErrorPolicy[] = ['exit']

/**
 * 节点的错误策略；未指定时为 `exit`。
 * @param node - 任一节点。
 */
export function errorPolicyOf(node: DagNodeDefinition): NodeErrorPolicy {
  return node.onError ?? 'exit'
}

/**
 * 节点能否失败，也就是它的错误策略是否会生效。
 *
 * `run` 工作流中，边界节点之外的每个节点执行时都可能失败；`code` 工作流中，只有调用的函数另外返回错误的节点会失败：
 * 最后一个结果是错误的原子，以及生成的函数总是返回错误的子工作流。
 * @param node - 任一节点。
 * @param kind - 节点所在工作流的种类。
 * @param callees - 节点能调用的原子和工作流。
 */
export function canFail(node: DagNodeDefinition, kind: WorkflowKind, callees: Callees): boolean {
  switch (kind) {
    case 'run':
      return !isBoundaryNode(node)
    case 'code':
      return calleeSignature(node, callees)?.fails === true
    default:
      return assertNever(kind)
  }
}
