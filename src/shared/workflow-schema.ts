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

/** 两个类型键集合的差异；相同时为 never。 */
type KeyDifference<A, B> = Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A>

/**
 * 把 schema 断言为声明类型 `T`，并在编译期要求 schema 输出的键与 `T` 的键完全相同。
 *
 * 断言是必要的：zod 输出省略缺失的可选键，却把它们类型化为 `T | undefined`，且不产生品牌 ID 类型；断言只恢复声明类型，
 * 不改变运行时值。键检查使 schema 漏掉的字段成为编译错误，而不是被 zod 在解析时悄悄删掉。
 * @returns 接受 schema 并返回 `z.ZodType<T>` 的函数；键不同时调用处不能通过类型检查。
 */
function declared<T>() {
  return <S extends z.ZodType>(
    schema: S & ([KeyDifference<z.output<S>, T>] extends [never] ? unknown : { readonly mismatchedKeys: KeyDifference<z.output<S>, T> }),
  ): z.ZodType<T> => schema as unknown as z.ZodType<T>
}

const nonEmptyString = z.string().refine(value => value.trim() !== '', {
  error: '必须为非空字符串',
})

/** 一个工作流端口的 JSON 表示。 */
export const workflowPortSchema = declared<PortDefinition>()(z.object({
  name: nonEmptyString,
  type: nonEmptyString,
  description: nonEmptyString.optional(),
  required: z.boolean().optional(),
  display: z.enum(['value', 'json']).optional(),
  default: z.json().optional(),
}))

const controlIdentity = { name: nonEmptyString, label: nonEmptyString }

/** 节点卡片配置控件的 JSON 表示。 */
export const nodeControlSchema = declared<NodeControlDefinition>()(z.discriminatedUnion('kind', [
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
]))

const editorPosition = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
})

/** 一个工作流节点的 JSON 表示。 */
export const workflowNodeSchema = declared<DagNodeDefinition>()(z.object({
  id: nonEmptyString,
  type: nonEmptyString,
  label: nonEmptyString.optional(),
  config: z.record(z.string(), z.json()).default({}),
  recovery: z.enum(['rerun', 'hold']).optional(),
  position: editorPosition.optional(),
  width: z.number().positive().optional(),
  outputs: z.array(workflowPortSchema).optional(),
  inputs: z.array(workflowPortSchema).optional(),
}))

const edgeIdentity = {
  id: nonEmptyString,
  source: nonEmptyString,
  target: nonEmptyString,
  sourcePort: nonEmptyString.optional(),
  targetPort: nonEmptyString.optional(),
}

/** 一条工作流边的 JSON 表示；`kind` 决定端口名属于数据端口还是执行引脚。 */
export const workflowEdgeSchema = declared<DagEdgeDefinition>()(z.discriminatedUnion('kind', [
  z.object({ ...edgeIdentity, kind: z.literal('data') }),
  z.object({ ...edgeIdentity, kind: z.literal('exec') }),
]))

/** 工作流种类的 JSON schema。 */
export const workflowKindSchema = z.enum(['run', 'code'])

/** 完整工作流定义的持久化和 Remote JSON schema。 */
export const workflowDefinitionSchema = declared<DagWorkflowDefinition>()(z.object({
  name: nonEmptyString,
  // 第二种工作流出现之前保存的记录没有这个字段，它们都是被执行的工作流。
  kind: workflowKindSchema.default(DEFAULT_WORKFLOW_KIND),
  language: nonEmptyString.optional(),
  atomFolder: nonEmptyString.optional(),
  description: nonEmptyString.optional(),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
}))

const runStatus = z.enum(['running', 'paused', 'interrupted', 'completed', 'failed', 'cancelled'])

const jsonObject = z.record(z.string(), z.json())

// 请求与结果的含义由声明该请求的节点决定；此处只要求可读回的 JSON 结构。
const nodeSignalRequestSchema = declared<NodeSignalRequest>()(z.object({
  id: z.string().min(1),
  request: z.json(),
  result: z.json().optional(),
  createdAt: z.number(),
  resolvedAt: z.number().optional(),
}))

const nodeRunRecordSchema = declared<NodeRunRecord>()(z.object({
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
}))

/** 一条运行记录的持久化 schema。 */
export const workflowRunRecordSchema = declared<WorkflowRunRecord>()(z.object({
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  definition: workflowDefinitionSchema,
  status: runStatus,
  error: z.string().optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
  nodes: z.array(nodeRunRecordSchema),
  outputs: jsonObject.optional(),
}))

/** 运行列表中一行的 Remote JSON schema。 */
export const workflowRunSummarySchema = declared<WorkflowRunSummary>()(z.object({
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
}))

/** 编辑器快照的 Remote JSON schema。 */
export const workflowStudioSnapshotSchema = declared<WorkflowStudioSnapshot>()(z.object({
  workflows: z.array(z.object({
    id: z.string().min(1),
    name: z.string(),
    kind: workflowKindSchema,
    description: z.string().optional(),
    definition: z.string(),
  })),
  nodeTypes: z.array(z.object({
    type: z.string(),
    label: z.string(),
    description: z.string(),
    sourcePlugin: z.string(),
    execKind: z.enum(['plain', 'decision', 'join']),
    kinds: z.array(workflowKindSchema),
    inputs: z.array(workflowPortSchema),
    outputs: z.array(workflowPortSchema),
    execOutputs: z.array(z.string()),
    controls: z.array(nodeControlSchema),
    variadicInputs: z.object({ min: z.number(), outputType: z.literal('same').optional() }).optional(),
  })),
}))

/** Host 读出的原子目录文件的 Remote JSON schema。 */
export const atomFilesSchema = z.array(declared<AtomFile>()(z.object({ file: z.string(), text: z.string() })))

/** 一层 Host 目录的 Remote JSON schema。 */
export const folderListingSchema = declared<FolderListing>()(z.object({
  path: z.string(),
  parent: z.string().optional(),
  folders: z.array(z.object({ name: z.string(), path: z.string() })),
  files: z.array(z.string()),
}))
