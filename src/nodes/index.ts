/**
 * dsh-workflow-studio/nodes 插件入口：注册 Workflow Studio 提供的通用节点。
 *
 * 与核心插件分开挂载；在 profile 中禁用本行即可移除这些节点。
 * @module dsh-workflow-studio/nodes
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '../registry.ts'
import { HumanApprovalNode } from './approval.ts'

/** Cordis 插件名，同时作为这些节点的来源插件名。 */
export const name = 'dsh-workflow-studio/nodes'

/** 注册节点所需的服务。 */
export const inject = ['workflowNodeRegistry']

/**
 * 插件 apply。
 * @param ctx - 带有 workflowNodeRegistry 的 Cordis context。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.workflowNodeRegistry.register(new HumanApprovalNode(), name), 'workflow-studio-nodes:human-approval')
}

export {
  APPROVAL_QUESTION_ID, APPROVAL_REQUEST_ID, DEFAULT_APPROVAL_QUESTION, HumanApprovalNode,
} from './approval.ts'
