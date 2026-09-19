/**
 * 节点等待外部结果：声明请求、结果校验、持久化，以及 Host 重启后的复用。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { askUser, parseAnswer, questionsRequest, requestQuestions, validateQuestionsSignal } from '../src/shared/questions.ts'
import { NodeId, type RunId } from '../src/shared/types.ts'
import type { DagEngineProvider } from '../src/engine-provider.ts'
import type { JsonValue, NodeExecutionContext, NodeExecutionResult, NodeRecoveryPolicy, WorkflowNodeExecutor } from '../src/shared/types.ts'
import { TestHosts, runEnded, signalRequested } from './host.ts'

const QUESTIONS: AskUserQuestionItem[] = [
  { id: 'color', question: 'Pick a color', options: [{ label: 'red' }, { label: 'blue' }] },
  { id: 'extras', question: 'Pick extras', options: [{ label: 'a' }, { label: 'b' }], multiSelect: true },
]

describe('提问请求与答案校验', () => {
  it('拒绝空问题列表、重复问题 ID 和重复选项', () => {
    assert.deepEqual(questionsRequest(QUESTIONS), { kind: 'questions', questions: QUESTIONS })
    assert.throws(() => questionsRequest([]), /questions 必须为非空数组/)
    assert.throws(() => questionsRequest([QUESTIONS[0]!, QUESTIONS[0]!]), /问题 ID "color" 重复/)
    assert.throws(
      () => questionsRequest([{ id: 'x', question: 'X', options: [{ label: 'a' }, { label: 'a' }] }]),
      /选项 "a" 重复/,
    )
  })

  it('只从提问请求中读回问题', () => {
    assert.deepEqual(requestQuestions(questionsRequest(QUESTIONS) as unknown as JsonValue), QUESTIONS)
    assert.equal(requestQuestions({ kind: 'job', jobId: '7' }), undefined)
    assert.equal(requestQuestions({ kind: 'questions', questions: [] }), undefined)
  })

  it('答案按问题顺序返回，并拒绝缺失、未知、非选项和单选多值', () => {
    assert.deepEqual(
      parseAnswer(QUESTIONS, { answers: [{ id: 'extras', selected: ['a', 'b'] }, { id: 'color', selected: [], custom: 'green' }] }),
      { answers: [{ id: 'color', selected: [], custom: 'green' }, { id: 'extras', selected: ['a', 'b'] }] },
    )
    assert.throws(() => parseAnswer(QUESTIONS, { answers: [{ id: 'color', selected: ['red'] }] }), /缺少问题 "extras"/)
    assert.throws(() => parseAnswer(QUESTIONS, {
      answers: [{ id: 'color', selected: ['red'] }, { id: 'extras', selected: [] }, { id: 'size', selected: [] }],
    }), /未知问题 "size"/)
    assert.throws(() => parseAnswer(QUESTIONS, {
      answers: [{ id: 'color', selected: ['green'] }, { id: 'extras', selected: [] }],
    }), /没有选项 "green"/)
    assert.throws(() => parseAnswer(QUESTIONS, {
      answers: [{ id: 'color', selected: ['red', 'blue'] }, { id: 'extras', selected: [] }],
    }), /为单选/)
    assert.throws(() => parseAnswer(QUESTIONS, 'red'), /答案必须为/)
  })

  it('校验函数只接受提问请求', () => {
    assert.throws(() => validateQuestionsSignal({ kind: 'job' }, ANSWER), /不是 questions 信号/)
  })
})

/** 可观察的 asker 调用。 */
interface Calls {
  asks: number
}

/**
 * `asker` 提问后把答案作为输出；`block` 为 true 时在收到答案后阻塞到取消。
 * `waiter` 等待一个不带校验的自定义请求。
 */
function executors(calls: Calls, options: { block?: boolean; recovery?: NodeRecoveryPolicy } = {}): WorkflowNodeExecutor[] {
  const asker: WorkflowNodeExecutor = {
    type: 'asker',
    label: 'Asker',
    description: 'Asks a question and outputs the answer',
    outputs: [{ name: 'answer', type: 'any' }],
    ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
    validateSignal: validateQuestionsSignal,
    async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
      calls.asks++
      const answer = await askUser(context, 'pick', QUESTIONS)
      if (options.block === true) {
        await new Promise<void>((resolve) => { context.signal.addEventListener('abort', () => { resolve() }) })
      }
      return { status: 'completed', outputs: { answer } }
    },
  }
  const waiter: WorkflowNodeExecutor = {
    type: 'waiter',
    label: 'Waiter',
    description: 'Waits for an external job result',
    outputs: [{ name: 'output', type: 'any' }],
    async execute(context) {
      const result = await context.awaitSignal('job', { kind: 'job', jobId: '7' })
      return { status: 'completed', outputs: { output: result } }
    },
  }
  return [asker, waiter]
}

/** 等待条件成立，最多约 2 秒。 */
async function until(predicate: () => boolean): Promise<void> {
  for (let tick = 0; tick < 200; tick++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('condition not reached')
}

const ANSWER = { answers: [{ id: 'color', selected: ['blue'] }, { id: 'extras', selected: ['a'] }] }

describe('节点等待外部结果', () => {
  const hosts = new TestHosts()
  afterEach(async () => { await hosts.cleanup() })

  async function saveAsker(engine: DagEngineProvider): Promise<RunId> {
    const workflowId = await engine.save({
      name: 'ask',
      nodes: [{ id: NodeId('ask'), type: 'asker', config: {} }],
      edges: [],
    })
    return engine.start(workflowId).runId
  }

  it('节点等待结果；结果经节点校验后写入运行记录并交给节点', async () => {
    const root = await hosts.root()
    const calls = { asks: 0 }
    const { ctx, engine } = await hosts.start(root, executors(calls))
    const requested = signalRequested(ctx, 'ask')
    const runId = await saveAsker(engine)
    assert.equal((await requested).requestId, 'pick')

    const waiting = engine.getRun(runId)!.nodes[0]!
    assert.equal(waiting.status, 'running')
    assert.deepEqual(waiting.requests?.map(item => [item.id, item.result]), [['pick', undefined]])
    assert.equal(engine.listRuns()[0]?.pendingRequests, 1)

    await assert.rejects(engine.signal(runId, NodeId('ask'), 'pick', { answers: [] }), /缺少问题 "color"/)
    await assert.rejects(engine.signal(runId, NodeId('ask'), 'other', ANSWER), /没有请求 other/)
    await assert.rejects(engine.signal(runId, NodeId('missing'), 'pick', ANSWER), /没有节点 missing/)

    const done = runEnded(ctx, runId)
    await engine.signal(runId, NodeId('ask'), 'pick', ANSWER)
    await assert.rejects(engine.signal(runId, NodeId('ask'), 'pick', ANSWER), /已送达结果/)
    const result = await done
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.nodes[0]?.outputs, { answer: ANSWER })
    assert.deepEqual(result.nodes[0]?.requests?.[0]?.result, ANSWER)
    assert.equal(engine.listRuns()[0]?.pendingRequests, 0)
    await assert.rejects(engine.signal(runId, NodeId('ask'), 'pick', ANSWER), /已送达结果|已结束/)
  })

  it('没有声明 validateSignal 的节点接受任何 JSON 结果', async () => {
    const { ctx, engine } = await hosts.start(await hosts.root(), executors({ asks: 0 }))
    const requested = signalRequested(ctx, 'w')
    const workflowId = await engine.save({
      name: 'job',
      nodes: [{ id: NodeId('w'), type: 'waiter', config: {} }],
      edges: [],
    })
    const run = engine.start(workflowId)
    const { requestId } = await requested
    assert.equal(requestId, 'job')
    assert.deepEqual(engine.getRun(run.runId)!.nodes[0]?.requests?.[0]?.request, { kind: 'job', jobId: '7' })

    await assert.rejects(engine.signal(run.runId, NodeId('w'), 'job', () => 1), /不是 JSON 值/)
    await engine.signal(run.runId, NodeId('w'), 'job', { done: true })
    assert.deepEqual((await run.result).nodes[0]?.outputs, { output: { done: true } })
  })

  it('等待中的请求在重启后保留，重新调用的节点不会重复声明', async () => {
    const root = await hosts.root()
    const first = await hosts.start(root, executors({ asks: 0 }))
    const requested = signalRequested(first.ctx, 'ask')
    const runId = await saveAsker(first.engine)
    await requested
    await first.ctx.fiber.dispose()

    const calls = { asks: 0 }
    const second = await hosts.start(root, executors(calls))
    await until(() => second.engine.listRuns()[0]?.pendingRequests === 1 && calls.asks === 1)
    const record = second.engine.getRun(runId)!.nodes[0]!
    assert.equal(record.requests?.length, 1)

    const done = runEnded(second.ctx, runId)
    await second.engine.signal(runId, NodeId('ask'), 'pick', ANSWER)
    const result = await done
    assert.equal(result.status, 'completed')
    assert.equal(result.nodes[0]?.attempts, 2)
  })

  it('重启前已送达的结果在重新调用时直接返回', async () => {
    const root = await hosts.root()
    const first = await hosts.start(root, executors({ asks: 0 }, { block: true }))
    const requested = signalRequested(first.ctx, 'ask')
    const runId = await saveAsker(first.engine)
    await requested
    await first.engine.signal(runId, NodeId('ask'), 'pick', ANSWER)
    await first.ctx.fiber.dispose()

    const second = await hosts.start(root, executors({ asks: 0 }))
    const result = await runEnded(second.ctx, runId)
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.nodes[0]?.outputs, { answer: ANSWER })
    assert.equal(result.nodes[0]?.requests?.length, 1)
  })

  it('interrupted 运行也可送达结果，恢复后节点直接得到它', async () => {
    const root = await hosts.root()
    const first = await hosts.start(root, executors({ asks: 0 }))
    const requested = signalRequested(first.ctx, 'ask')
    const runId = await saveAsker(first.engine)
    await requested
    await first.ctx.fiber.dispose()

    const second = await hosts.start(root, executors({ asks: 0 }), { autoRestart: false })
    assert.equal(second.engine.getRun(runId)?.status, 'interrupted')
    assert.equal(second.engine.listRuns()[0]?.pendingRequests, 1)
    await second.engine.signal(runId, NodeId('ask'), 'pick', ANSWER)
    assert.equal(second.engine.listRuns()[0]?.pendingRequests, 0)

    const done = runEnded(second.ctx, runId)
    second.engine.resumeRun(runId)
    assert.deepEqual((await done).nodes[0]?.outputs, { answer: ANSWER })
  })

  it('recovery: hold 的等待节点在重启后需要人工恢复', async () => {
    const root = await hosts.root()
    const first = await hosts.start(root, executors({ asks: 0 }, { recovery: 'hold' }))
    const requested = signalRequested(first.ctx, 'ask')
    const runId = await saveAsker(first.engine)
    await requested
    await first.ctx.fiber.dispose()

    const second = await hosts.start(root, executors({ asks: 0 }, { recovery: 'hold' }))
    await until(() => second.engine.getRun(runId)?.status === 'interrupted')
    assert.match(second.engine.getRun(runId)?.error ?? '', /需要人工恢复/)
  })
})
