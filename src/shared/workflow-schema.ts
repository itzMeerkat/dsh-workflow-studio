/**
 * 工作流定义、运行记录与编辑器快照的共享 JSON schema。
 *
 * Host 用它校验持久化记录和 Remote 入参，浏览器用它解析 Remote 返回值。
 * @module dsh-workflow-studio
 */

import { z } from 'zod'
import type {
  DagEdgeDefinition,
  DagNodeDefinition,
  DagWorkflowDefinition,
  HumanInputRequest,
  NodeControlDefinition,
  NodeRunRecord,
  PortDefinition,
  WorkflowRunRecord,
  WorkflowRunSummary,
  WorkflowStudioSnapshot,
} from './types.ts'

// 每个 schema 断言为对应的声明类型：zod 输出省略缺失的可选键，但把它们类型化为 `T | undefined`，
// 且不产生品牌 ID 类型；断言只恢复声明类型，不改变运行时值。
const nonEmptyString = z.string().refine(value => value.trim() !== '', {
  error: '必须为非空字符串',
})
const portType = z.enum(['number', 'string', 'boolean', 'any'])

/** 一个工作流端口的 JSON 表示。 */
export const workflowPortSchema = z.object({
  name: nonEmptyString,
  type: portType,
  description: nonEmptyString.optional(),
  required: z.boolean().optional(),
  role: z.literal('condition').optional(),
  display: z.enum(['value', 'json']).optional(),
}) as unknown as z.ZodType<PortDefinition>

const controlIdentity = { name: nonEmptyString, label: nonEmptyString }

/** 节点卡片配置控件的 JSON 表示。 */
export const nodeControlSchema = z.discriminatedUnion('kind', [
  z.object({
    ...controlIdentity,
    kind: z.literal('number'),
    defaultValue: z.number(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
  }),
  z.object({ ...controlIdentity, kind: z.literal('text'), defaultValue: z.string(), placeholder: z.string().optional() }),
  z.object({ ...controlIdentity, kind: z.literal('boolean'), defaultValue: z.boolean() }),
  z.object({
    ...controlIdentity,
    kind: z.literal('select'),
    defaultValue: z.string(),
    options: z.array(z.object({ label: z.string(), value: z.string() })),
  }),
]) as unknown as z.ZodType<NodeControlDefinition>

/** 一个工作流节点的 JSON 表示。 */
export const workflowNodeSchema = z.object({
  id: nonEmptyString,
  type: nonEmptyString,
  label: nonEmptyString.optional(),
  config: z.record(z.string(), z.json()).default({}),
  requiresHumanInput: z.boolean().optional(),
  recovery: z.enum(['rerun', 'hold']).optional(),
  position: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
  }).optional(),
  outputs: z.array(workflowPortSchema).optional(),
  inputs: z.array(workflowPortSchema).optional(),
}) as unknown as z.ZodType<DagNodeDefinition>

/** 一条工作流边的 JSON 表示。 */
export const workflowEdgeSchema = z.object({
  id: nonEmptyString,
  source: nonEmptyString,
  sourcePort: nonEmptyString.optional(),
  target: nonEmptyString,
  targetPort: nonEmptyString.optional(),
}) as unknown as z.ZodType<DagEdgeDefinition>

/** 完整工作流定义的持久化和 Remote JSON schema。 */
export const workflowDefinitionSchema = z.object({
  name: nonEmptyString,
  description: nonEmptyString.optional(),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
  inputs: z.array(workflowPortSchema).optional(),
  outputs: z.array(workflowPortSchema).optional(),
}) as unknown as z.ZodType<DagWorkflowDefinition>

const runStatus = z.enum(['running', 'paused', 'interrupted', 'completed', 'failed', 'cancelled'])

const jsonObject = z.record(z.string(), z.json())

// 问题和答案在提问与回答时由 human-input.ts 校验；此处只要求可读回的 JSON 结构。
const humanInputRequestSchema = z.object({
  id: z.string().min(1),
  questions: z.array(z.json()),
  answer: z.json().optional(),
  askedAt: z.number(),
  answeredAt: z.number().optional(),
}) as unknown as z.ZodType<HumanInputRequest>

const nodeRunRecordSchema = z.object({
  nodeId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(['pending', 'running', 'awaiting-input', 'completed', 'skipped', 'failed', 'cancelled']),
  attempts: z.number().int().nonnegative(),
  inputs: jsonObject.optional(),
  outputs: jsonObject.optional(),
  error: z.string().optional(),
  notepad: z.json().optional(),
  interactions: z.array(humanInputRequestSchema).optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
}) as unknown as z.ZodType<NodeRunRecord>

/** 一条运行记录的持久化 schema。 */
export const workflowRunRecordSchema = z.object({
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  definition: workflowDefinitionSchema,
  status: runStatus,
  error: z.string().optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
  nodes: z.array(nodeRunRecordSchema),
}) as unknown as z.ZodType<WorkflowRunRecord>

/** 运行列表中一行的 Remote JSON schema。 */
export const workflowRunSummarySchema = z.object({
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  name: z.string(),
  status: runStatus,
  awaitingInput: z.number().int().nonnegative(),
  error: z.string().optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
}) as unknown as z.ZodType<WorkflowRunSummary>

/** 编辑器快照的 Remote JSON schema。 */
export const workflowStudioSnapshotSchema = z.object({
  workflows: z.array(z.object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().optional(),
    definition: z.string(),
  })),
  nodeTypes: z.array(z.object({
    type: z.string(),
    label: z.string(),
    description: z.string(),
    sourcePlugin: z.string(),
    requiresHumanInput: z.boolean().optional(),
    inputs: z.array(workflowPortSchema),
    outputs: z.array(workflowPortSchema),
    controls: z.array(nodeControlSchema),
    variadicInputs: z.object({ min: z.number(), outputType: z.literal('same').optional() }).optional(),
  })),
}) as unknown as z.ZodType<WorkflowStudioSnapshot>
