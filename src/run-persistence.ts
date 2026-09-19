/**
 * 工作流运行记录的持久化 Domain 声明。
 *
 * 每个 Run ID 对应 `workflow_studio_runs/runs` 表中的一条记录；记录包含运行启动时的定义快照、
 * 运行状态和每个节点的状态、调用次数、输入输出与 notepad。与工作流定义 Domain 分离，
 * 使运行记录的清理和演进不影响已保存的定义。
 * @module dsh-workflow-studio
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { RunId, WorkflowRunRecord } from './types.ts'
import { workflowRunRecordSchema } from './workflow-schema.ts'

/** 运行记录 Domain。每个运行独立持久化，一次检查点只重写该运行的文件。 */
export const workflowRunsDomainSpec = defineDomain({
  name: 'workflow_studio_runs',
  version: 1,
  layout: 'per-record',
  tables: {
    runs: domainTable<RunId, WorkflowRunRecord>(workflowRunRecordSchema),
  },
})
