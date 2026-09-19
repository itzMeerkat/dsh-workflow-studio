/**
 * 节点人工输入：提问、回答校验、持久化，以及 Host 重启后的复用。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { parseAnswer, parseQuestions } from '../src/human-input.ts'
import { NodeId, type RunId } from '../src/types.ts'
import type { DagEngineProvider } from '../src/engine-provider.ts'
import type { NodeExecutionContext, NodeExecutionResult, NodeRecoveryPolicy, WorkflowNodeExecutor } from '../src/types.ts'
import { TestHosts, inputRequested, runEnded } from './host.ts'

const QUESTIONS: AskUserQuestionItem[] = [
  { id: 'color', question: 'Pick a color', options: [{ label: 'red' }, { label: 'blue' }] },
  { id: 'extras', question: 'Pick extras', options: [{ label: 'a' }, { label: 'b' }], multiSelect: true },
]

describe('问题与答案校验', () => {
  it('拒绝空请求 ID、保留前缀、重复问题 ID 和重复选项', () => {
    assert.throws(() => parseQuestions('', QUESTIONS), /requestId 必须为非空字符串/)
    assert.throws(() => parseQuestions('dsh.mine', QUESTIONS), /不得以 "dsh\." 开头/)
    assert.deepEqual(parseQuestions('dsh.confirm', QUESTIONS, true), QUESTIONS)
    assert.throws(() => parseQuestions('q', []), /questions 必须为非空数组/)
    assert.throws(() => parseQuestions('q', [QUESTIONS[0], QUESTIONS[0]]), /问题 ID "color" 重复/)
    assert.throws(
      () => parseQuestions('q', [{ id: 'x', question: 'X', options: [{ label: 'a' }, { label: 'a' }] }]),
      /选项 "a" 重复/,
    )
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
})

/** 可观察的 asker 调用。 */
interface Calls {
  asks: number
}

/**
 * `asker` 提问后把答案作为输出；`block` 为 true 时在收到答案后阻塞到取消。
 */
function executors(calls: Calls, options: { block?: boolean; recovery?: NodeRecoveryPolicy } = {}): WorkflowNodeExecutor[] {
  const asker: WorkflowNodeExecutor = {
    type: 'asker',
    label: 'Asker',
    description: 'Asks a question and outputs the answer',
    outputs: [{ name: 'answer', type: 'any' }],
    ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
    async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
      calls.asks++
      const answer = await context.askHuman('pick', QUESTIONS)
      if (options.block === true) {
        await new Promise<void>((resolve) => { context.signal.addEventListener('abort', () => { resolve() }) })
      }
      return { status: 'completed', outputs: { answer } }
    },
  }
  const reserved: WorkflowNodeExecutor = {
    type: 'reserved-asker',
    label: 'Reserved',
    description: 'Uses an engine-reserved request ID',
    async execute(context) {
      await context.askHuman('dsh.confirm', QUESTIONS)
      return { status: 'completed', outputs: {} }
    },
  }
  return [asker, reserved]
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

describe('节点人工输入', () => {
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

  it('节点等待答案；答案校验后写入运行记录并交给节点', async () => {
    const root = await hosts.root()
    const calls = { asks: 0 }
    const { ctx, engine } = await hosts.start(root, executors(calls))
    const requested = inputRequested(ctx, 'ask')
    const runId = await saveAsker(engine)
    assert.equal((await requested).requestId, 'pick')

    const waiting = engine.getRun(runId)!.nodes[0]!
    assert.equal(waiting.status, 'awaiting-input')
    assert.deepEqual(waiting.interactions?.map(item => [item.id, item.answer]), [['pick', undefined]])
    assert.equal(engine.listRuns()[0]?.awaitingInput, 1)

    await assert.rejects(engine.answerInput(runId, NodeId('ask'), 'pick', { answers: [] }), /缺少问题 "color"/)
    await assert.rejects(engine.answerInput(runId, NodeId('ask'), 'other', ANSWER), /没有请求 other/)
    await assert.rejects(engine.answerInput(runId, NodeId('missing'), 'pick', ANSWER), /没有节点 missing/)

    const done = runEnded(ctx, runId)
    await engine.answerInput(runId, NodeId('ask'), 'pick', ANSWER)
    await assert.rejects(engine.answerInput(runId, NodeId('ask'), 'pick', ANSWER), /已回答/)
    const result = await done
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.nodes[0]?.outputs, { answer: ANSWER })
    assert.deepEqual(result.nodes[0]?.interactions?.[0]?.answer, ANSWER)
    assert.equal(engine.listRuns()[0]?.awaitingInput, 0)
    await assert.rejects(engine.answerInput(runId, NodeId('ask'), 'pick', ANSWER), /已回答|已结束/)
  })

  it('节点不能使用引擎保留的请求 ID', async () => {
    const { engine } = await hosts.start(await hosts.root(), executors({ asks: 0 }))
    const workflowId = await engine.save({
      name: 'reserved',
      nodes: [{ id: NodeId('r'), type: 'reserved-asker', config: {} }],
      edges: [],
    })
    const result = await engine.start(workflowId).result
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /不得以 "dsh\." 开头/)
  })

  it('等待中的问题在重启后保留，重新调用的节点不会重复提问', async () => {
    const root = await hosts.root()
    const first = await hosts.start(root, executors({ asks: 0 }))
    const requested = inputRequested(first.ctx, 'ask')
    const runId = await saveAsker(first.engine)
    await requested
    await first.ctx.fiber.dispose()

    const calls = { asks: 0 }
    const second = await hosts.start(root, executors(calls))
    await until(() => second.engine.getRun(runId)?.nodes[0]?.status === 'awaiting-input' && calls.asks === 1)
    const record = second.engine.getRun(runId)!.nodes[0]!
    assert.equal(calls.asks, 1)
    assert.equal(record.interactions?.length, 1)

    const done = runEnded(second.ctx, runId)
    await second.engine.answerInput(runId, NodeId('ask'), 'pick', ANSWER)
    const result = await done
    assert.equal(result.status, 'completed')
    assert.equal(result.nodes[0]?.attempts, 2)
  })

  it('重启前已回答的问题在重新调用时直接返回保存的答案', async () => {
    const root = await hosts.root()
    const first = await hosts.start(root, executors({ asks: 0 }, { block: true }))
    const requested = inputRequested(first.ctx, 'ask')
    const runId = await saveAsker(first.engine)
    await requested
    await first.engine.answerInput(runId, NodeId('ask'), 'pick', ANSWER)
    await first.ctx.fiber.dispose()

    const second = await hosts.start(root, executors({ asks: 0 }))
    const result = await runEnded(second.ctx, runId)
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.nodes[0]?.outputs, { answer: ANSWER })
    assert.equal(result.nodes[0]?.interactions?.length, 1)
  })

  it('interrupted 运行也可回答，恢复后节点直接得到答案', async () => {
    const root = await hosts.root()
    const first = await hosts.start(root, executors({ asks: 0 }))
    const requested = inputRequested(first.ctx, 'ask')
    const runId = await saveAsker(first.engine)
    await requested
    await first.ctx.fiber.dispose()

    const second = await hosts.start(root, executors({ asks: 0 }), { autoRestart: false })
    assert.equal(second.engine.getRun(runId)?.status, 'interrupted')
    assert.equal(second.engine.listRuns()[0]?.awaitingInput, 1)
    await second.engine.answerInput(runId, NodeId('ask'), 'pick', ANSWER)
    assert.equal(second.engine.listRuns()[0]?.awaitingInput, 0)

    const done = runEnded(second.ctx, runId)
    second.engine.resumeRun(runId)
    assert.deepEqual((await done).nodes[0]?.outputs, { answer: ANSWER })
  })

  it('仅等待执行前确认的节点在重启后自动恢复，不受 recovery: hold 约束', async () => {
    const confirmNode = (recovery: NodeRecoveryPolicy): WorkflowNodeExecutor => ({
      type: 'confirmed',
      label: 'Confirmed',
      description: 'Runs after confirmation',
      requiresHumanInput: true,
      recovery,
      execute: () => ({ status: 'completed', outputs: {} }),
    })
    const root = await hosts.root()
    const first = await hosts.start(root, [confirmNode('hold')])
    const requested = inputRequested(first.ctx)
    const workflowId = await first.engine.save({
      name: 'confirm',
      nodes: [{ id: NodeId('c'), type: 'confirmed', config: {} }],
      edges: [],
    })
    const runId = first.engine.start(workflowId).runId
    await requested
    await first.ctx.fiber.dispose()

    const second = await hosts.start(root, [confirmNode('hold')])
    const again = inputRequested(second.ctx)
    assert.equal(second.engine.getRun(runId)?.status, 'running')
    await again
    const done = runEnded(second.ctx, runId)
    await second.engine.answerInput(runId, NodeId('c'), 'dsh.confirm', { answers: [{ id: 'decision', selected: ['批准'] }] })
    assert.equal((await done).status, 'completed')
  })
})
