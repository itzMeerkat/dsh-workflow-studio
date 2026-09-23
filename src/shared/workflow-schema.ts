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
  NodeSignalRequest,
  NodeControlDefinition,
  NodeRunRecord,
  PortDefinition,
  WorkflowRunRecord,
  WorkflowRunSummary,
  WorkflowStudioSnapshot,
  FolderListing,
} from './types.ts'
import type { AtomFile } from './language.ts'
import { DEFAULT_WORKFLOW_KIND } from './types.ts'

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
  display: z.enum(['value', 'json']).optional(),
  default: z.json().optional(),
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
  z.object({
    ...controlIdentity,
    kind: z.literal('textarea'),
    defaultValue: z.string(),
    placeholder: z.string().optional(),
    rows: z.number().int().positive().optional(),
  }),
  z.object({ ...controlIdentity, kind: z.literal('boolean'), defaultValue: z.boolean() }),
  z.object({
    ...controlIdentity,
    kind: z.literal('select'),
    defaultValue: z.string(),
    options: z.array(z.object({ label: z.string(), value: z.string() })),
  }),
]) as unknown as z.ZodType<NodeControlDefinition>

const editorPosition = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
})

/** 一个工作流节点的 JSON 表示。 */
export const workflowNodeSchema = z.object({
  id: nonEmptyString,
  type: nonEmptyString,
  label: nonEmptyString.optional(),
  config: z.record(z.string(), z.json()).default({}),
  recovery: z.enum(['rerun', 'hold']).optional(),
  position: editorPosition.optional(),
  outputs: z.array(workflowPortSchema).optional(),
  inputs: z.array(workflowPortSchema).optional(),
}) as unknown as z.ZodType<DagNodeDefinition>

const edgeIdentity = {
  id: nonEmptyString,
  source: nonEmptyString,
  target: nonEmptyString,
  sourcePort: nonEmptyString.optional(),
  targetPort: nonEmptyString.optional(),
}

/** 一条工作流边的 JSON 表示；`kind` 决定端口名属于数据端口还是执行引脚。 */
export const workflowEdgeSchema = z.discriminatedUnion('kind', [
  z.object({ ...edgeIdentity, kind: z.literal('data') }),
  z.object({ ...edgeIdentity, kind: z.literal('exec') }),
]) as unknown as z.ZodType<DagEdgeDefinition>

const workflowKind = z.enum(['run', 'code'])

/** 完整工作流定义的持久化和 Remote JSON schema。 */
export const workflowDefinitionSchema = z.object({
  name: nonEmptyString,
  // 第二种工作流出现之前保存的记录没有这个字段，它们都是被执行的工作流。
  kind: workflowKind.default(DEFAULT_WORKFLOW_KIND),
  language: nonEmptyString.optional(),
  atomFolder: nonEmptyString.optional(),
  description: nonEmptyString.optional(),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
}) as unknown as z.ZodType<DagWorkflowDefinition>

const runStatus = z.enum(['running', 'paused', 'interrupted', 'completed', 'failed', 'cancelled'])

const jsonObject = z.record(z.string(), z.json())

// 请求与结果的含义由声明该请求的节点决定；此处只要求可读回的 JSON 结构。
const nodeSignalRequestSchema = z.object({
  id: z.string().min(1),
  request: z.json(),
  result: z.json().optional(),
  createdAt: z.number(),
  resolvedAt: z.number().optional(),
}) as unknown as z.ZodType<NodeSignalRequest>

const nodeRunRecordSchema = z.object({
  nodeId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(['pending', 'running', 'completed', 'skipped', 'failed', 'cancelled']),
  attempts: z.number().int().nonnegative(),
  inputs: jsonObject.optional(),
  outputs: jsonObject.optional(),
  error: z.string().optional(),
  notepad: z.json().optional(),
  requests: z.array(nodeSignalRequestSchema).optional(),
  fired: z.array(z.string()).optional(),
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
  pendingRequests: z.number().int().nonnegative(),
  skippedNodes: z.number().int().nonnegative(),
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
    kind: workflowKind,
    description: z.string().optional(),
    definition: z.string(),
  })),
  nodeTypes: z.array(z.object({
    type: z.string(),
    label: z.string(),
    description: z.string(),
    sourcePlugin: z.string(),
    execKind: z.enum(['plain', 'decision', 'join']),
    kinds: z.array(workflowKind),
    inputs: z.array(workflowPortSchema),
    outputs: z.array(workflowPortSchema),
    execOutputs: z.array(z.string()),
    controls: z.array(nodeControlSchema),
    variadicInputs: z.object({ min: z.number(), outputType: z.literal('same').optional() }).optional(),
  })),
}) as unknown as z.ZodType<WorkflowStudioSnapshot>

/** Host 读出的原子目录文件的 Remote JSON schema。 */
export const atomFilesSchema = z.array(z.object({ file: z.string(), text: z.string() })) as z.ZodType<AtomFile[]>

/** 一层 Host 目录的 Remote JSON schema。 */
export const folderListingSchema = z.object({
  path: z.string(),
  parent: z.string().optional(),
  folders: z.array(z.object({ name: z.string(), path: z.string() })),
  files: z.array(z.string()),
}) as unknown as z.ZodType<FolderListing>
