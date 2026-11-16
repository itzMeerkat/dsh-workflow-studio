/**
 * A run started by the model follows its calling Session as a background job.
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { JobId, type JobOutcome, type JobToolCall } from '@deepseek-ai/dsh-jobs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { startLinkedRun } from '../src/session-link.ts'
import { WORKFLOW_OUTPUT_TYPE } from '../src/shared/workflow-boundary.ts'
import { createFixtureNodes } from './fixture-nodes.ts'
import { workflow } from './graph-fixtures.ts'
import { TestHosts } from './host.ts'

describe('Session link', () => {
  const hosts = new TestHosts()
  afterEach(async () => { await hosts.cleanup() })

  it('runs as a job of the calling Session, asks its questions there, and settles with the run outputs', async () => {
    const { ctx, engine } = await hosts.start(await hosts.root(), createFixtureNodes())
    const id = await engine.save(workflow({
      q: 'ask',
      out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [{ name: 'answer', type: 'string', required: false }] },
    }, ['q:answer>out:answer'], { name: 'confirm' }))
    const agent = { id: 'session-1' } as NonNullable<ToolExecution['agent']>
    const call = { callId: 'call-1', rootCallId: 'call-1' } as JobToolCall
    assert.equal(startLinkedRun(ctx, engine, id, {}, agent, call), undefined)

    const output: string[] = []
    const asked: AskUserQuestionItem[][] = []
    const jobId = JobId('workflow-run-1')
    let done: Promise<JobOutcome> | undefined
    await ctx.plugin({
      apply(scope: Context) {
        scope.reflect.provide('jobs', {
          start(spec) {
            done = spec.run({ id: jobId, append: (text) => { output.push(text) }, updateProgress: () => {} }).done
            return jobId
          },
        } as Context['jobs'])
        scope.reflect.provide('userQuestions', {
          async ask(request) {
            asked.push(request.questions)
            return { answers: [{ id: 'decision', selected: ['yes'] }] }
          },
        } as Context['userQuestions'])
      },
    })

    const linked = startLinkedRun(ctx, engine, id, {}, agent, call)!
    assert.equal(linked.jobId, jobId)
    assert.deepEqual(await done, { status: 'completed', result: '{"answer":"yes"}' })
    assert.deepEqual(asked.map(questions => questions.map(question => question.question)), [['Go?']])
    assert.ok(output.some(line => line.startsWith('ask (q) waits for an answer to request pick')))
    assert.equal(engine.getRun(linked.run.runId)?.status, 'completed')
  })
})
