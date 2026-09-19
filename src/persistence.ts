/**
 * 工作流定义的持久化 Domain 声明。
 *
 * 每个 Workflow ID 对应 `workflow_studio/workflows` 表中的一条记录；
 * `per-record` JSON 后端会为每条记录创建独立文件。
 * @module dsh-workflow-studio
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DagWorkflowDefinition, WorkflowId } from './types.ts'
import { workflowDefinitionSchema } from './workflow-schema.ts'

/**
 * 工作流定义 Domain。每条工作流独立持久化，避免一次保存重写其他定义。
 */
export const workflowStudioDomainSpec = defineDomain({
  name: 'workflow_studio',
  version: 1,
  layout: 'per-record',
  tables: {
    workflows: domainTable<WorkflowId, DagWorkflowDefinition>(workflowDefinitionSchema),
  },
})
