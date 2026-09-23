/**
 * dsh-workflow-studio 主插件入口。
 *
 * 注册节点表、执行引擎、模型面工具，以及存在技能表时的 `workflow-code-atoms` 技能。
 * 本插件自带流程控制节点、边界节点、`code` 工作流的代码节点和写出源码的语言，其余节点由插件提供。
 * @module dsh-workflow-studio
 */

import type { Context } from '@deepseek-ai/cordis'
import { WorkflowNodeRegistry } from './registry.ts'
import { DagEngineProvider, type DagEngineConfig } from './engine-provider.ts'
import { registerWorkflowTools } from './tools.ts'
import { WorkflowStudioController } from './controller.ts'
import { registerWorkflowSkill } from './skill.ts'

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
    registerWorkflowTools(scope)
  })

  registerWorkflowSkill(ctx)
}

export { WorkflowNodeRegistry } from './registry.ts'
export { DagEngineProvider } from './engine-provider.ts'
export { topologicalSort } from './validation.ts'
export type { DagEngineConfig } from './engine-provider.ts'
export {
  APPROVE_LABEL, QUESTIONS_KIND, REJECT_LABEL, answerComment, askUser, isApproved,
  parseAnswer, questionsRequest, requestQuestions, validateQuestionsSignal,
} from './shared/questions.ts'
export type { QuestionsRequest } from './shared/questions.ts'
export { toJsonValue, toJsonObject } from './shared/json.ts'
export {
  EXEC_RUN_PIN, EXEC_THEN_PIN, execOutputPins, execSourcePin, execTargetPin, isDataEdge, isExecEdge,
} from './shared/graph.ts'
export { NodeFailure, WorkflowNode, toFailureResult } from './node.ts'
export { BRANCH_FALSE_PIN, BRANCH_TRUE_PIN, BranchNode, MergeNode } from './flow-nodes.ts'
export {
  WORKFLOW_INPUT_TYPE, WORKFLOW_OUTPUT_TYPE, boundaryPorts, boundarySide, isBoundaryNode, withBoundaryPorts,
  withRunInputs, workflowInputNode, workflowInputPorts, workflowOutputNode, workflowOutputPorts,
} from './shared/workflow-boundary.ts'
export type { WorkflowNodePorts } from './node.ts'
export {
  DIAGNOSTIC_SEVERITY, analyzeWorkflow, atomNode, atomPin, indexNodeTypes,
} from './shared/analysis.ts'
export type {
  Guard, WorkflowAnalysis, WorkflowDiagnostic, WorkflowDiagnosticCode,
} from './shared/analysis.ts'
export { buildWorkflowIr } from './shared/ir.ts'
export type {
  IrArgument, IrArm, IrBlock, IrCall, IrGuard, IrItem, IrOutputs, IrValue, WorkflowIr,
} from './shared/ir.ts'
export { RenderError, renderWorkflow } from './shared/source.ts'
export type { RenderFault } from './shared/source.ts'
export {
  ATOM_FIELD, CODE_ATOM_TYPE, CODE_BLOCK_TYPE, CODE_CONDITION_TYPE, CODE_FIELD, CODE_LANGUAGES, GO, PSEUDOCODE,
  PYTHON, TYPESCRIPT, languageOf,
} from './shared/language.ts'
export type {
  Atom, AtomFault, AtomSyntax, FunctionSyntax, Language, Signature, TypedName,
} from './shared/language.ts'
export { describeDiagnostic, describeRenderFault } from './diagnostic-message.ts'
export { registerWorkflowTools } from './tools.ts'
export { WORKFLOW_CODE_SKILL, registerWorkflowSkill } from './skill.ts'
export { WorkflowStudioController } from './controller.ts'
export { workflowRunsDomainSpec, workflowStudioDomainSpec } from './persistence.ts'
export { workflowDefinitionSchema, workflowRunRecordSchema } from './shared/workflow-schema.ts'
export { DagEngine } from './engine.ts'
export type { DagRun } from './engine.ts'
export type {
  DagWorkflowDefinition, DagNodeDefinition, DagEdgeDefinition,
  WorkflowNodeExecutor, NodeExecutionContext, NodeExecutionResult,
  DagDataEdge, DagExecEdge,
  NodeExecutionCompleted, NodeExecutionFailed, NodeControlDefinition,
  WorkflowSummary, WorkflowRunStatus, WorkflowRunSummary, WorkflowRunRecord,
  NodeRecoveryPolicy, NodeNotepad, JsonValue, JsonObject, NodeSignalRequest,
  NodeRunRecord, NodeRunStatus, PortDefinition, NodeTypeSummary, NodeExecKind, WorkflowKind,
  WorkflowStudioSnapshot,
} from './shared/types.ts'
export {
  DEFAULT_WORKFLOW_KIND, WorkflowId, RunId, NodeId, EdgeId,
} from './shared/types.ts'
