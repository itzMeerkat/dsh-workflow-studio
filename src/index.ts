/**
 * dsh-workflow-studio 主插件入口。
 *
 * 注册节点表、执行引擎、内置节点和模型面工具。
 * @module dsh-workflow-studio
 */

import type { Context } from '@deepseek-ai/cordis'
import { WorkflowNodeRegistry } from './registry.ts'
import { DagEngineProvider } from './engine-provider.ts'
import { registerBuiltinNodes } from './basic-nodes.ts'
import { registerWorkflowTools } from './tools.ts'
import { WorkflowStudioController } from './controller.ts'

/** 插件运行所需的 Harness 服务。 */
export const inject = ['tools', 'storageDomain']

/**
 * 插件 apply。
 * @param ctx - Cordis context。
 */
export function apply(ctx: Context): void {
  ctx.plugin(WorkflowNodeRegistry)

  ctx.inject(['workflowNodeRegistry'], (scope) => {
    scope.plugin(DagEngineProvider)
    return registerBuiltinNodes(scope)
  })

  ctx.inject(['dagEngine', 'workflowNodeRegistry'], (scope) => {
    scope.plugin(WorkflowStudioController)
    return registerWorkflowTools(scope)
  })
}

export { WorkflowNodeRegistry } from './registry.ts'
export { DagEngineProvider, topologicalSort } from './engine-provider.ts'
export { registerBuiltinNodes } from './basic-nodes.ts'
export { registerWorkflowTools } from './tools.ts'
export { WorkflowStudioController } from './controller.ts'
export { workflowStudioDomainSpec } from './persistence.ts'
export { workflowDefinitionSchema } from './workflow-schema.ts'
export { DagEngine } from './engine.ts'
export type { DagRun } from './engine.ts'
export type {
  DagWorkflowDefinition, DagNodeDefinition, DagEdgeDefinition,
  WorkflowNodeExecutor, NodeExecutionContext, NodeExecutionResult,
  WorkflowResult, WorkflowSummary, WorkflowRunStatus,
  NodeRunRecord, NodeRunStatus, PortDefinition,
} from './types.ts'
export {
  WorkflowId, RunId, NodeId, EdgeId,
} from './types.ts'
