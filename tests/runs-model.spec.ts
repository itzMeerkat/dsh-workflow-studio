/**
 * Browser runs-model tests.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildAnswer,
  groupRuns,
  isAnswerComplete,
  parseRunRecord,
  parseRunSummaries,
  pendingRequests,
  runActions,
  runRecordsByNode,
} from '../src/client/runs-model.ts'
import { RunId, WorkflowId, type WorkflowRunSummary } from '../src/shared/types.ts'

function row(runId: string, status: WorkflowRunSummary['status'], workflowId = 'w1', pendingRequests = 0): WorkflowRunSummary {
  return {
    runId: RunId(runId),
    workflowId: WorkflowId(workflowId),
    name: 'flow',
    status,
    pendingRequests,
    skippedNodes: 0,
    startedAt: 1,
    updatedAt: 1,
  }
}

const QUESTIONS = [
  { id: 'single', question: 'One?', options: [{ label: 'a' }, { label: 'b' }] },
  { id: 'multi', question: 'Many?', options: [{ label: 'x' }, { label: 'y' }], multiSelect: true },
]

function recordSource(status: string, requests: unknown[]): string {
  return JSON.stringify({
    runId: 'r1',
    workflowId: 'w1',
    status,
    startedAt: 1,
    updatedAt: 2,
    definition: {
      name: 'flow',
      kind: 'run' as const,
      nodes: [{ id: 'ask', type: 'asker', label: 'Ask me', config: {} }, { id: 'out', type: 'output', config: {} }],
      edges: [],
    },
    nodes: [
      { nodeId: 'ask', runId: 'r1', status: 'running', attempts: 1, startedAt: 1, requests },
      { nodeId: 'out', runId: 'r1', status: 'completed', attempts: 1, startedAt: 1, outputs: { output: 3 } },
    ],
  })
}

describe('runs model', () => {
  it('parses run summaries and rejects unknown statuses', () => {
    const rows = [row('r1', 'running')]
    assert.deepEqual(parseRunSummaries(JSON.stringify(rows)), rows)
    assert.throws(() => parseRunSummaries(JSON.stringify([{ ...rows[0], status: 'lost' }])))
  })

  it('groups unfinished or waiting runs as active, optionally for one workflow', () => {
    const rows = [
      row('running', 'running'),
      row('done', 'completed'),
      row('other', 'interrupted', 'w2'),
      row('waiting', 'interrupted', 'w1', 1),
    ]
    assert.deepEqual(groupRuns(rows, 'w1'), { active: [rows[0], rows[3]], history: [rows[1]] })
    assert.deepEqual(groupRuns(rows, undefined).active.map(item => item.runId), ['running', 'other', 'waiting'])
  })

  it('lists requests still waiting with their node, and none for finished runs', () => {
    const requests = [
      { id: 'done', request: { kind: 'questions', questions: QUESTIONS }, result: { answers: [] }, createdAt: 1, resolvedAt: 2 },
      { id: 'open', request: { kind: 'questions', questions: QUESTIONS }, createdAt: 3 },
    ]
    const pending = pendingRequests(parseRunRecord(recordSource('running', requests)))
    assert.deepEqual(
      pending.map(item => [item.nodeId, item.nodeLabel, item.nodeType, item.request.id]),
      [['ask', 'Ask me', 'asker', 'open']],
    )
    assert.deepEqual(pendingRequests(parseRunRecord(recordSource('cancelled', requests))), [])
  })

  it('builds answers: custom text replaces a single choice and supplements multiple choices', () => {
    const draft = { selected: { single: ['a'], multi: ['x'] }, custom: { single: '  mine ', multi: 'z' } }
    assert.deepEqual(buildAnswer(QUESTIONS, draft), {
      answers: [{ id: 'single', selected: [], custom: 'mine' }, { id: 'multi', selected: ['x'], custom: 'z' }],
    })
    assert.deepEqual(buildAnswer(QUESTIONS, { selected: { single: ['b'] }, custom: {} }), {
      answers: [{ id: 'single', selected: ['b'] }, { id: 'multi', selected: [] }],
    })
    assert.equal(isAnswerComplete(QUESTIONS, { selected: { single: ['b'] }, custom: {} }), false)
    assert.equal(isAnswerComplete(QUESTIONS, { selected: { single: ['b'] }, custom: { multi: 'z' } }), true)
  })

  it('offers controls by status and maps node records for overlays', () => {
    assert.deepEqual(runActions('running'), { pause: true, resume: false, cancel: true })
    assert.deepEqual(runActions('interrupted'), { pause: false, resume: true, cancel: true })
    assert.deepEqual(runActions('completed'), { pause: false, resume: false, cancel: false })
    const overlay = runRecordsByNode(parseRunRecord(recordSource('running', [])))
    assert.deepEqual(overlay.get('out'), { nodeId: 'out', runId: 'r1', status: 'completed', attempts: 1, startedAt: 1, outputs: { output: 3 } })
  })
})
