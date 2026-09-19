/**
 * 工作流运行记录的持久化 Domain 声明。
 *
 * 每个 Run ID 对应 `workflow_studio_runs/runs` 表中的一条记录；记录包含运行启动时的定义快照、
 * 运行状态和每个节点的状态、调用次数、输入输出与 notepad。与工作流定义 Domain 分离，
 * 使运行记录的清理和演进不影响已保存的定义。
 * @module dsh-workflow-studio
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { NodeId, RunId, WorkflowId } from './types.ts'
import type { JsonObject, JsonValue, NodeRunRecord, WorkflowRunRecord } from './types.ts'
import { workflowDefinitionSchema } from './workflow-schema.ts'

const jsonObject = z.record(z.string(), z.json()) as z.ZodType<JsonObject>

const nodeRunRecordSchema = z.object({
  nodeId: z.string().min(1).transform(NodeId),
  runId: z.string().min(1).transform(RunId),
  status: z.enum(['pending', 'running', 'paused', 'completed', 'skipped', 'failed', 'cancelled']),
  attempts: z.number().int().nonnegative(),
  inputs: jsonObject.optional(),
  outputs: jsonObject.optional(),
  error: z.string().optional(),
  notepad: (z.json() as z.ZodType<JsonValue>).optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
}).transform((raw): NodeRunRecord => ({
  nodeId: raw.nodeId,
  runId: raw.runId,
  status: raw.status,
  attempts: raw.attempts,
  startedAt: raw.startedAt,
  ...(raw.inputs === undefined ? {} : { inputs: raw.inputs }),
  ...(raw.outputs === undefined ? {} : { outputs: raw.outputs }),
  ...(raw.error === undefined ? {} : { error: raw.error }),
  ...(raw.notepad === undefined ? {} : { notepad: raw.notepad }),
  ...(raw.completedAt === undefined ? {} : { completedAt: raw.completedAt }),
}))

/** 一条运行记录的持久化 schema。 */
export const workflowRunRecordSchema: z.ZodType<WorkflowRunRecord> = z.object({
  runId: z.string().min(1).transform(RunId),
  workflowId: z.string().min(1).transform(WorkflowId),
  definition: workflowDefinitionSchema,
  status: z.enum(['running', 'paused', 'interrupted', 'completed', 'failed', 'cancelled']),
  error: z.string().optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
  nodes: z.array(nodeRunRecordSchema),
}).transform((raw): WorkflowRunRecord => ({
  runId: raw.runId,
  workflowId: raw.workflowId,
  definition: raw.definition,
  status: raw.status,
  startedAt: raw.startedAt,
  updatedAt: raw.updatedAt,
  nodes: raw.nodes,
  ...(raw.error === undefined ? {} : { error: raw.error }),
  ...(raw.completedAt === undefined ? {} : { completedAt: raw.completedAt }),
}))

/** 运行记录 Domain。每个运行独立持久化，一次检查点只重写该运行的文件。 */
export const workflowRunsDomainSpec = defineDomain({
  name: 'workflow_studio_runs',
  version: 1,
  layout: 'per-record',
  tables: {
    runs: domainTable<RunId, WorkflowRunRecord>(workflowRunRecordSchema),
  },
})
