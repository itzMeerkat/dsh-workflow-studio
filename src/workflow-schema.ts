/**
 * 工作流定义的共享 JSON schema。
 *
 * Host 用它校验持久化记录，浏览器用它解析 Remote 返回的定义。
 * @module dsh-workflow-studio
 */

import { z } from 'zod'
import type {
  DagEdgeDefinition,
  DagNodeDefinition,
  DagWorkflowDefinition,
  NodeControlDefinition,
  PortDefinition,
} from './types.ts'
import { EdgeId, NodeId } from './types.ts'

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
