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
  JsonObject,
  JsonValue,
  NodeControlDefinition,
  NodeRunRecord,
  PortDefinition,
  WorkflowRunRecord,
  WorkflowRunSummary,
  WorkflowStudioSnapshot,
} from './types.ts'
import { EdgeId, NodeId, RunId, WorkflowId } from './types.ts'

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
}).transform((raw): PortDefinition => ({
  name: raw.name,
  type: raw.type,
  ...(raw.description === undefined ? {} : { description: raw.description }),
  ...(raw.required === undefined ? {} : { required: raw.required }),
  ...(raw.role === undefined ? {} : { role: raw.role }),
  ...(raw.display === undefined ? {} : { display: raw.display }),
}))

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
  id: nonEmptyString.transform(NodeId),
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
}).transform((raw): DagNodeDefinition => ({
  id: raw.id,
  type: raw.type,
  config: raw.config,
  ...(raw.label === undefined ? {} : { label: raw.label }),
  ...(raw.requiresHumanInput === undefined ? {} : { requiresHumanInput: raw.requiresHumanInput }),
  ...(raw.recovery === undefined ? {} : { recovery: raw.recovery }),
  ...(raw.position === undefined ? {} : { position: raw.position }),
  ...(raw.outputs === undefined ? {} : { outputs: raw.outputs }),
  ...(raw.inputs === undefined ? {} : { inputs: raw.inputs }),
}))

/** 一条工作流边的 JSON 表示。 */
export const workflowEdgeSchema = z.object({
  id: nonEmptyString.transform(EdgeId),
  source: nonEmptyString.transform(NodeId),
  sourcePort: nonEmptyString.optional(),
  target: nonEmptyString.transform(NodeId),
  targetPort: nonEmptyString.optional(),
}).transform((raw): DagEdgeDefinition => ({
  id: raw.id,
  source: raw.source,
  target: raw.target,
  ...(raw.sourcePort === undefined ? {} : { sourcePort: raw.sourcePort }),
  ...(raw.targetPort === undefined ? {} : { targetPort: raw.targetPort }),
}))

/** 完整工作流定义的持久化和 Remote JSON schema。 */
export const workflowDefinitionSchema: z.ZodType<DagWorkflowDefinition> = z.object({
  name: nonEmptyString,
  description: nonEmptyString.optional(),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
  inputs: z.array(workflowPortSchema).optional(),
  outputs: z.array(workflowPortSchema).optional(),
}).transform((raw): DagWorkflowDefinition => ({
  name: raw.name,
  nodes: raw.nodes,
  edges: raw.edges,
  ...(raw.description === undefined ? {} : { description: raw.description }),
  ...(raw.inputs === undefined ? {} : { inputs: raw.inputs }),
  ...(raw.outputs === undefined ? {} : { outputs: raw.outputs }),
}))

const runStatus = z.enum(['running', 'paused', 'interrupted', 'completed', 'failed', 'cancelled'])

const jsonObject = z.record(z.string(), z.json()) as z.ZodType<JsonObject>

// 问题和答案在提问与回答时由 human-input.ts 校验；此处只要求可读回的 JSON 结构。
const humanInputRequestSchema = z.object({
  id: z.string().min(1),
  questions: z.array(z.json()) as unknown as z.ZodType<HumanInputRequest['questions']>,
  answer: (z.json() as unknown as z.ZodType<NonNullable<HumanInputRequest['answer']>>).optional(),
  askedAt: z.number(),
  answeredAt: z.number().optional(),
}).transform((raw): HumanInputRequest => ({
  id: raw.id,
  questions: raw.questions,
  askedAt: raw.askedAt,
  ...(raw.answer === undefined ? {} : { answer: raw.answer }),
  ...(raw.answeredAt === undefined ? {} : { answeredAt: raw.answeredAt }),
}))

const nodeRunRecordSchema = z.object({
  nodeId: z.string().min(1).transform(NodeId),
  runId: z.string().min(1).transform(RunId),
  status: z.enum(['pending', 'running', 'awaiting-input', 'completed', 'skipped', 'failed', 'cancelled']),
  attempts: z.number().int().nonnegative(),
  inputs: jsonObject.optional(),
  outputs: jsonObject.optional(),
  error: z.string().optional(),
  notepad: (z.json() as z.ZodType<JsonValue>).optional(),
  interactions: z.array(humanInputRequestSchema).optional(),
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
  ...(raw.interactions === undefined ? {} : { interactions: raw.interactions }),
  ...(raw.completedAt === undefined ? {} : { completedAt: raw.completedAt }),
}))

/** 一条运行记录的持久化 schema。 */
export const workflowRunRecordSchema: z.ZodType<WorkflowRunRecord> = z.object({
  runId: z.string().min(1).transform(RunId),
  workflowId: z.string().min(1).transform(WorkflowId),
  definition: workflowDefinitionSchema,
  status: runStatus,
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

/** 运行列表中一行的 Remote JSON schema。 */
export const workflowRunSummarySchema = z.object({
  runId: z.string().min(1).transform(RunId),
  workflowId: z.string().min(1).transform(WorkflowId),
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
    id: z.string().min(1).transform(WorkflowId),
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
