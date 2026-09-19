/**
 * dsh-workflow-studio 主插件入口。
 *
 * 注册节点表、执行引擎和模型面工具；本插件不注册任何节点。
 * @module dsh-workflow-studio
 */

import type { Context } from '@deepseek-ai/cordis'
import { WorkflowNodeRegistry } from './registry.ts'
import { DagEngineProvider, type DagEngineConfig } from './engine-provider.ts'
import { registerWorkflowTools } from './tools.ts'
import { WorkflowStudioController } from './controller.ts'

/** 插件运行所需的 Harness 服务。 */
export const inject = ['tools', 'storageDomain']

/** 插件配置：传给 {@link DagEngineProvider} 的引擎配置。 */
export interface Config extends DagEngineConfig {}

export const Config = DagEngineProvider.Config

/**
 * 插件 apply。
 * @param ctx - Cordis context。
 * @param config - 引擎配置。
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(WorkflowNodeRegistry)

  ctx.inject(['workflowNodeRegistry'], (scope) => {
    scope.plugin(DagEngineProvider, config)
  })

  ctx.inject(['dagEngine', 'workflowNodeRegistry'], (scope) => {
    scope.plugin(WorkflowStudioController)
    return registerWorkflowTools(scope)
  })
}

export { WorkflowNodeRegistry } from './registry.ts'
export { DagEngineProvider, topologicalSort } from './engine-provider.ts'
export type { DagEngineConfig } from './engine-provider.ts'
export { workflowRunsDomainSpec } from './run-persistence.ts'
export { CONDITION_PORT, NodeFailure, WorkflowNode } from './node.ts'
export type { WorkflowNodePorts } from './node.ts'
export { registerWorkflowTools } from './tools.ts'
export { WorkflowStudioController } from './controller.ts'
export { workflowStudioDomainSpec } from './persistence.ts'
export { workflowDefinitionSchema } from './workflow-schema.ts'
export { DagEngine } from './engine.ts'
export type { DagRun } from './engine.ts'
export type {
  DagWorkflowDefinition, DagNodeDefinition, DagEdgeDefinition,
  WorkflowNodeExecutor, NodeExecutionContext, NodeExecutionResult,
  NodeExecutionCompleted, NodeExecutionFailed, NodeExecutionSkipped, NodeControlDefinition,
  WorkflowResult, WorkflowSummary, WorkflowRunStatus, WorkflowRunSummary, WorkflowRunRecord,
  NodeRecoveryPolicy, NodeNotepad, JsonValue, JsonObject,
  NodeRunRecord, NodeRunStatus, PortDefinition,
} from './types.ts'
export {
  WorkflowId, RunId, NodeId, EdgeId,
} from './types.ts'
