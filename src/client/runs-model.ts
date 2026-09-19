/**
 * Browser-side parsing and grouping for workflow runs and their human-input requests.
 */

import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions/types'
import { z } from 'zod'
import type {
  HumanInputRequest, NodeRunRecord, WorkflowRunRecord, WorkflowRunStatus, WorkflowRunSummary,
} from '../shared/types.ts'
import { workflowRunRecordSchema, workflowRunSummarySchema } from '../shared/workflow-schema.ts'

/**
 * Parse the `listRuns` Remote result.
 * @param source - JSON array of run summaries.
 * @returns The rows in Host order (newest first).
 */
export function parseRunSummaries(source: string): WorkflowRunSummary[] {
  return z.array(workflowRunSummarySchema).parse(JSON.parse(source) as unknown)
}

/**
 * Parse a run record returned by `getRun` or a control Remote.
 * @param source - JSON run record.
 * @returns The parsed record.
 */
export function parseRunRecord(source: string): WorkflowRunRecord {
  return workflowRunRecordSchema.parse(JSON.parse(source) as unknown)
}

/**
 * Whether a run still needs attention: it is unfinished, or it waits for an answer.
 * @param row - Run summary.
 */
export function isActiveRun(row: Pick<WorkflowRunSummary, 'status' | 'awaitingInput'>): boolean {
  return !isFinished(row.status) || row.awaitingInput > 0
}

/**
 * Whether a run has reached a final status.
 * @param status - Run status.
 */
export function isFinished(status: WorkflowRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/**
 * Split runs into active and finished groups, optionally limited to one workflow.
 * @param rows - Run summaries, newest first.
 * @param workflowId - Workflow to keep, or undefined for all workflows.
 * @returns Both groups in their input order.
 */
export function groupRuns(
  rows: readonly WorkflowRunSummary[],
  workflowId: string | undefined,
): { active: WorkflowRunSummary[]; history: WorkflowRunSummary[] } {
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
  readonly request: HumanInputRequest
}

/**
 * List a run's unanswered human-input requests in node order. Finished runs have none.
 * @param record - Run record.
 */
export function pendingRequests(record: WorkflowRunRecord): PendingRequest[] {
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
export function runActions(status: WorkflowRunStatus): { pause: boolean; resume: boolean; cancel: boolean } {
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
export function runRecordsByNode(record: WorkflowRunRecord): ReadonlyMap<string, NodeRunRecord> {
  return new Map(record.nodes.map(node => [node.nodeId, node]))
}
