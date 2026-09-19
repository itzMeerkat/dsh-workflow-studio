/**
 * Runs view: active and finished runs, run controls, pending questions, and node states.
 */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { useState } from 'react'
import { ExecutionOrderView } from './ExecutionOrderView.tsx'
import type { NodeTypeSummary, WorkflowRunRecord, WorkflowRunSummary } from '../shared/types.ts'
import {
  buildAnswer,
  groupRuns,
  isAnswerComplete,
  pendingRequests,
  runActions,
  runRecordsByNode,
  type AnswerDraft,
  type PendingRequest,
} from './runs-model.ts'
import css from './WorkflowStudioPanel.module.css'
import type { Translate, WorkflowStudioKey } from './locale.ts'

/** Which runs the rail lists. */
export type RunsFilter = 'workflow' | 'all'

/** Run controls offered for the selected run. */
export type RunAction = 'pause' | 'resume' | 'cancel'

interface RunsViewProps {
  readonly t: Translate
  readonly runs: readonly WorkflowRunSummary[]
  readonly filter: RunsFilter
  readonly currentWorkflowId: string | undefined
  readonly selectedRunId: string | undefined
  readonly record: WorkflowRunRecord | undefined
  readonly nodeTypes: readonly NodeTypeSummary[]
  readonly busy: boolean
  readonly onFilter: (filter: RunsFilter) => void
  readonly onSelect: (runId: string) => void
  readonly onAction: (action: RunAction) => void
  readonly onAnswer: (nodeId: string, requestId: string, answer: AskUserQuestionAnswer) => void
}

/** List runs beside the selected run's details. */
export function RunsView(props: RunsViewProps) {
  const { t, runs, filter, currentWorkflowId, selectedRunId, record } = props
  const { active, history } = groupRuns(runs, filter === 'workflow' ? currentWorkflowId : undefined)
  return (
    <div className={css.runsLayout}>
      <aside className={css.runsRail} aria-label={t('view.runs')}>
        <div className={css.viewTabs} role="tablist" aria-label={t('runs.filter')}>
          {(['workflow', 'all'] as const).map(value => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => { props.onFilter(value) }}
            >
              {t(value === 'workflow' ? 'runs.filter.workflow' : 'runs.filter.all')}
            </button>
          ))}
        </div>
        <RunGroup title={t('runs.active')} rows={active} selectedRunId={selectedRunId} showName={filter === 'all'} t={t} onSelect={props.onSelect} />
        <RunGroup title={t('runs.history')} rows={history} selectedRunId={selectedRunId} showName={filter === 'all'} t={t} onSelect={props.onSelect} />
        {active.length === 0 && history.length === 0 && <p className={css.runsEmpty}>{t('runs.empty')}</p>}
      </aside>
      <section className={css.runDetail}>
        {record === undefined
          ? <p className={css.runsEmpty}>{t('runs.select')}</p>
          : <RunDetail {...props} record={record} />}
      </section>
    </div>
  )
}

function RunGroup({ title, rows, selectedRunId, showName, t, onSelect }: {
  readonly title: string
  readonly rows: readonly WorkflowRunSummary[]
  readonly selectedRunId: string | undefined
  readonly showName: boolean
  readonly t: Translate
  readonly onSelect: (runId: string) => void
}) {
  if (rows.length === 0) return null
  return (
    <div className={css.runGroup}>
      <h3>{title}</h3>
      {rows.map(row => (
        <button
          key={row.runId}
          type="button"
          className={row.runId === selectedRunId ? `${css.runRow} ${css.runRowActive}` : css.runRow}
          onClick={() => { onSelect(row.runId) }}
        >
          <span className={css.runStatus} data-status={row.awaitingInput > 0 ? 'awaiting-input' : row.status}>
            {row.awaitingInput > 0 ? `${t('runStatus.awaiting')} · ${row.awaitingInput}` : t(`runStatus.${row.status}`)}
          </span>
          {showName && <strong>{row.name}</strong>}
          <time dateTime={new Date(row.startedAt).toISOString()}>{formatTime(row.startedAt)}</time>
          {row.completedAt !== undefined && <small>{formatDuration(row.completedAt - row.startedAt)}</small>}
        </button>
      ))}
    </div>
  )
}

function RunDetail({ t, record, nodeTypes, busy, onAction, onAnswer }: RunsViewProps & { readonly record: WorkflowRunRecord }) {
  const actions = runActions(record.status)
  const pending = pendingRequests(record)
  const labels = new Map(record.definition.nodes.map(node => [node.id, node.label ?? node.id]))
  return (
    <>
      <header className={css.runHeader}>
        <div>
          <h2>{record.definition.name}</h2>
          <p>
            <span className={css.runStatus} data-status={record.status}>{t(`runStatus.${record.status}`)}</span>
            <span>{t('runs.started')} {formatTime(record.startedAt)}</span>
            {record.completedAt !== undefined && (
              <span>{t('runs.duration')} {formatDuration(record.completedAt - record.startedAt)}</span>
            )}
            <code>{record.runId}</code>
          </p>
          {record.error !== undefined && <p className={css.runError}>{record.error}</p>}
        </div>
        <div className={css.actions}>
          {actions.pause && <Button size="sm" variant="outline" disabled={busy} onClick={() => { onAction('pause') }}>{t('action.pause')}</Button>}
          {actions.resume && <Button size="sm" variant="primary" disabled={busy} onClick={() => { onAction('resume') }}>{t('action.resume')}</Button>}
          {actions.cancel && <Button size="sm" variant="outline" disabled={busy} onClick={() => { onAction('cancel') }}>{t('action.cancel')}</Button>}
        </div>
      </header>

      {pending.map(item => (
        <QuestionForm
          key={`${item.nodeId}/${item.request.id}`}
          item={item}
          busy={busy}
          t={t}
          onSubmit={(answer) => { onAnswer(item.nodeId, item.request.id, answer) }}
        />
      ))}

      <div className={css.runGraph}>
        <ExecutionOrderView definition={record.definition} nodeTypes={nodeTypes} runRecords={runRecordsByNode(record)} t={t} />
      </div>

      <table className={css.runNodes}>
        <thead>
          <tr>
            <th>{t('runs.node')}</th>
            <th>{t('runs.status')}</th>
            <th>{t('runs.attempts')}</th>
            <th>{t('runs.detail')}</th>
          </tr>
        </thead>
        <tbody>
          {record.nodes.map(node => (
            <tr key={node.nodeId}>
              <td>{labels.get(node.nodeId) ?? node.nodeId}</td>
              <td><span className={css.runStatus} data-status={node.status}>{t(`nodeStatus.${node.status}` as WorkflowStudioKey)}</span></td>
              <td>{node.attempts}</td>
              <td>
                {node.error !== undefined && <p className={css.runError}>{node.error}</p>}
                {node.outputs !== undefined && Object.keys(node.outputs).length > 0 && (
                  <pre>{JSON.stringify(node.outputs, null, 2)}</pre>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function QuestionForm({ item, busy, t, onSubmit }: {
  readonly item: PendingRequest
  readonly busy: boolean
  readonly t: Translate
  readonly onSubmit: (answer: AskUserQuestionAnswer) => void
}) {
  const [draft, setDraft] = useState<AnswerDraft>({ selected: {}, custom: {} })
  const questions = item.request.questions
  const toggle = (question: AskUserQuestionItem, label: string): void => {
    const current = draft.selected[question.id] ?? []
    const next = question.multiSelect === true
      ? (current.includes(label) ? current.filter(value => value !== label) : [...current, label])
      : [label]
    setDraft({ ...draft, selected: { ...draft.selected, [question.id]: next } })
  }
  return (
    <form
      className={css.questionCard}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(buildAnswer(questions, draft))
      }}
    >
      <p className={css.questionSource}>{t('questions.title')} · {t('questions.from')} {item.nodeLabel}</p>
      {questions.map(question => (
        <fieldset key={question.id}>
          {question.header !== undefined && <legend>{question.header}</legend>}
          <strong>{question.question}</strong>
          {question.detail !== undefined && <pre>{question.detail}</pre>}
          <div className={css.questionOptions}>
            {(question.options ?? []).map(option => (
              <label key={option.label}>
                <input
                  type={question.multiSelect === true ? 'checkbox' : 'radio'}
                  name={`${item.nodeId}/${item.request.id}/${question.id}`}
                  checked={(draft.selected[question.id] ?? []).includes(option.label)}
                  onChange={() => { toggle(question, option.label) }}
                />
                <span>{option.label}</span>
                {option.description !== undefined && <small>{option.description}</small>}
              </label>
            ))}
          </div>
          <input
            className={css.questionCustom}
            placeholder={t('questions.other')}
            value={draft.custom[question.id] ?? ''}
            onChange={(event) => {
              setDraft({ ...draft, custom: { ...draft.custom, [question.id]: event.currentTarget.value } })
            }}
          />
        </fieldset>
      ))}
      <Button size="sm" variant="primary" type="submit" disabled={busy || !isAnswerComplete(questions, draft)}>
        {t('questions.submit')}
      </Button>
    </form>
  )
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString()
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
