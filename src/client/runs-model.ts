/**
 * Browser-side parsing and grouping for workflow runs and their human-input requests.
 */

import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions/types'
import { z } from 'zod'
import { workflowDefinitionSchema } from '../workflow-schema.ts'
import type { EditorNodeRunRecord, EditorWorkflowDefinition } from './model.ts'

/** Run statuses the Host reports. */
export type RunStatus = 'running' | 'paused' | 'interrupted' | 'completed' | 'failed' | 'cancelled'

const runStatusSchema = z.enum(['running', 'paused', 'interrupted', 'completed', 'failed', 'cancelled'])

const runSummarySchema = z.object({
  runId: z.string(),
  workflowId: z.string(),
  name: z.string(),
  status: runStatusSchema,
  awaitingInput: z.number(),
  error: z.string().optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
})

/** One row of the runs list. */
export type RunSummaryRow = z.infer<typeof runSummarySchema>

const interactionSchema = z.object({
  id: z.string(),
  questions: z.array(z.custom<AskUserQuestionItem>(value => typeof value === 'object' && value !== null)),
  answer: z.custom<AskUserQuestionAnswer>(value => typeof value === 'object' && value !== null).optional(),
  askedAt: z.number(),
  answeredAt: z.number().optional(),
})

/** One human-input request recorded on a node. */
export type RunInteraction = z.infer<typeof interactionSchema>

const nodeRecordSchema = z.object({
  nodeId: z.string(),
  status: z.string(),
  attempts: z.number(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  interactions: z.array(interactionSchema).optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
})

/** One node's state within a run. */
export type RunNodeRecord = z.infer<typeof nodeRecordSchema>

const runRecordSchema = z.object({
  runId: z.string(),
  workflowId: z.string(),
  definition: workflowDefinitionSchema,
  status: runStatusSchema,
  error: z.string().optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
  nodes: z.array(nodeRecordSchema),
})

/** A full run record with its workflow snapshot. */
export interface RunRecordView {
  readonly runId: string
  readonly workflowId: string
  readonly definition: EditorWorkflowDefinition
  readonly status: RunStatus
  readonly error?: string | undefined
  readonly startedAt: number
  readonly updatedAt: number
  readonly completedAt?: number | undefined
  readonly nodes: readonly RunNodeRecord[]
}

/**
 * Parse the `listRuns` Remote result.
 * @param source - JSON array of run summaries.
 * @returns The rows in Host order (newest first).
 */
export function parseRunSummaries(source: string): RunSummaryRow[] {
  return z.array(runSummarySchema).parse(JSON.parse(source) as unknown)
}

/**
 * Parse a run record returned by `getRun` or a control Remote.
 * @param source - JSON run record.
 * @returns The parsed record.
 */
export function parseRunRecord(source: string): RunRecordView {
  return runRecordSchema.parse(JSON.parse(source) as unknown)
}

/**
 * Whether a run still needs attention: it is unfinished, or it waits for an answer.
 * @param row - Run summary.
 */
export function isActiveRun(row: Pick<RunSummaryRow, 'status' | 'awaitingInput'>): boolean {
  return !isFinished(row.status) || row.awaitingInput > 0
}

/**
 * Whether a run has reached a final status.
 * @param status - Run status.
 */
export function isFinished(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/**
 * Split runs into active and finished groups, optionally limited to one workflow.
 * @param rows - Run summaries, newest first.
 * @param workflowId - Workflow to keep, or undefined for all workflows.
 * @returns Both groups in their input order.
 */
export function groupRuns(
  rows: readonly RunSummaryRow[],
  workflowId: string | undefined,
): { active: RunSummaryRow[]; history: RunSummaryRow[] } {
  const visible = workflowId === undefined ? rows : rows.filter(row => row.workflowId === workflowId)
  return {
    active: visible.filter(row => isActiveRun(row)),
    history: visible.filter(row => !isActiveRun(row)),
  }
}

/** An unanswered request with the node that asked it. */
export interface PendingRequest {
  readonly nodeId: string
  readonly nodeLabel: string
  readonly request: RunInteraction
}

/**
 * List a run's unanswered human-input requests in node order. Finished runs have none.
 * @param record - Run record.
 */
export function pendingRequests(record: RunRecordView): PendingRequest[] {
  if (isFinished(record.status)) return []
  const labels = new Map(record.definition.nodes.map(node => [node.id, node.label ?? node.id]))
  return record.nodes.flatMap(node => (node.interactions ?? [])
    .filter(request => request.answer === undefined)
    .map(request => ({ nodeId: node.nodeId, nodeLabel: labels.get(node.nodeId) ?? node.nodeId, request })))
}

/** Selected option labels and custom text for each question of one request. */
export interface AnswerDraft {
  readonly selected: Readonly<Record<string, readonly string[]>>
  readonly custom: Readonly<Record<string, string>>
}

/**
 * Build the answer the Host expects from the form draft. Non-empty custom text replaces the
 * selection of a single-select question and supplements a multi-select one.
 * @param questions - The request's questions.
 * @param draft - The form state.
 * @returns One answer item per question, in question order.
 */
export function buildAnswer(questions: readonly AskUserQuestionItem[], draft: AnswerDraft): AskUserQuestionAnswer {
  return {
    answers: questions.map((question) => {
      const custom = draft.custom[question.id]?.trim() ?? ''
      const selected = [...(draft.selected[question.id] ?? [])]
      if (custom === '') return { id: question.id, selected }
      return { id: question.id, selected: question.multiSelect === true ? selected : [], custom }
    }),
  }
}

/**
 * Whether every question has a selection or custom text.
 * @param questions - The request's questions.
 * @param draft - The form state.
 */
export function isAnswerComplete(questions: readonly AskUserQuestionItem[], draft: AnswerDraft): boolean {
  return questions.every(question =>
    (draft.selected[question.id]?.length ?? 0) > 0 || (draft.custom[question.id]?.trim() ?? '') !== '')
}

/**
 * The run controls that apply to a status.
 * @param status - Run status.
 */
export function runActions(status: RunStatus): { pause: boolean; resume: boolean; cancel: boolean } {
  return {
    pause: status === 'running',
    resume: status === 'paused' || status === 'interrupted',
    cancel: !isFinished(status),
  }
}

/**
 * Node records keyed by node ID, for canvas and execution-order status overlays.
 * @param record - Run record.
 */
export function runRecordsByNode(record: RunRecordView): ReadonlyMap<string, EditorNodeRunRecord> {
  return new Map(record.nodes.map(node => [node.nodeId, {
    nodeId: node.nodeId,
    status: node.status,
    ...(node.outputs === undefined ? {} : { outputs: node.outputs }),
  }]))
}
