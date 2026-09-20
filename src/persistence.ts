/**
 * 工作流定义与运行记录的持久化 Domain 声明。
 *
 * 两个 Domain 都使用 `per-record` 布局，JSON 后端为每条记录创建独立文件，一次写入只重写该记录。
 * 运行记录与定义分属不同 Domain，使运行记录的清理和演进不影响已保存的定义。
 * @module dsh-workflow-studio
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DagWorkflowDefinition, RunId, WorkflowId, WorkflowRunRecord } from './shared/types.ts'
import { workflowDefinitionSchema, workflowRunRecordSchema } from './shared/workflow-schema.ts'

/** 工作流定义 Domain：`workflow_studio/workflows` 表中每个 Workflow ID 一条记录。 */
export const workflowStudioDomainSpec = defineDomain({
  name: 'workflow_studio',
  version: 2,
  layout: 'per-record',
  tables: {
    workflows: domainTable<WorkflowId, DagWorkflowDefinition>(workflowDefinitionSchema),
  },
})

/**
 * 运行记录 Domain：`workflow_studio_runs/runs` 表中每个 Run ID 一条记录，包含运行启动时的定义快照、
 * 运行状态和每个节点的状态、调用次数、输入输出、notepad 与人工输入请求。
 */
export const workflowRunsDomainSpec = defineDomain({
  name: 'workflow_studio_runs',
  version: 2,
  layout: 'per-record',
  tables: {
    runs: domainTable<RunId, WorkflowRunRecord>(workflowRunRecordSchema),
  },
})
