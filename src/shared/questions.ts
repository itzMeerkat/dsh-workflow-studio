/**
 * `questions` 请求格式：节点向人提问时使用的信号负载与答案校验。
 *
 * 问题与答案使用 Harness `dsh-user-questions` 的格式：问题可带选项、多选和展示意图，
 * 答案按问题 ID 给出所选选项标签和可选的自定义文本。引擎不解释该格式；
 * 节点用 {@link askUser} 提问，浏览器按 {@link QUESTIONS_KIND} 选择渲染方式。
 * @module dsh-workflow-studio
 */

import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions/types'
import { z } from 'zod'
import { toJsonValue } from './json.ts'
import type { JsonValue, NodeExecutionContext } from './types.ts'

/** 提问信号的 `kind`；浏览器按它选择渲染该请求的组件。 */
export const QUESTIONS_KIND = 'questions'

/** 提问信号的负载。 */
export interface QuestionsRequest {
  kind: typeof QUESTIONS_KIND
  questions: AskUserQuestionItem[]
}

/** 批准选项的标签。 */
export const APPROVE_LABEL = '批准'

/** 拒绝选项的标签。 */
export const REJECT_LABEL = '拒绝'

/**
 * 向人提问并等待答案。节点被重新调用后，以相同 `requestId` 再次提问时立即返回已保存的答案。
 * @param context - 节点执行上下文。
 * @param requestId - 节点内唯一且在重新调用间保持不变的请求 ID。
 * @param questions - 待提问的问题。
 * @returns 按问题顺序排列的答案；运行取消时拒绝。
 */
export async function askUser(
  context: NodeExecutionContext,
  requestId: string,
  questions: readonly AskUserQuestionItem[],
): Promise<AskUserQuestionAnswer> {
  // 请求和答案都是 JSON 对象；声明类型没有索引签名，断言只让它们满足 JsonValue。
  const result = await context.awaitSignal(requestId, questionsRequest(questions) as unknown as JsonValue)
  return parseAnswer(questions, result)
}

/**
 * 校验问题并构造提问信号的负载。问题 ID、问题文本和选项标签不得为空，
 * 问题 ID 和同一问题的选项标签不得重复。
 * @param questions - 待提问的问题。
 * @returns 可持久化的请求负载。
 */
export function questionsRequest(questions: readonly AskUserQuestionItem[]): QuestionsRequest {
  if (questions.length === 0) throw new TypeError('questions 必须为非空数组')
  const ids = new Set<string>()
  questions.forEach((question, index) => {
    const path = `questions[${index}]`
    requireText(question.id, `${path}.id`)
    if (ids.has(question.id)) throw new TypeError(`问题 ID "${question.id}" 重复`)
    ids.add(question.id)
    requireText(question.question, `${path}.question`)
    const labels = new Set<string>()
    for (const option of question.options ?? []) {
      requireText(option.label, `${path}.options[].label`)
      if (labels.has(option.label)) throw new TypeError(`问题 "${question.id}" 的选项 "${option.label}" 重复`)
      labels.add(option.label)
    }
  })
  return {
    kind: QUESTIONS_KIND,
    questions: toJsonValue(questions, 'questions') as unknown as AskUserQuestionItem[],
  }
}

const questionsRequestSchema = z.object({
  kind: z.literal(QUESTIONS_KIND),
  questions: z.array(z.looseObject({
    id: z.string().min(1),
    question: z.string().min(1),
    header: z.string().optional(),
    detail: z.string().optional(),
    multiSelect: z.boolean().optional(),
    options: z.array(z.looseObject({ label: z.string().min(1) })).optional(),
  })).min(1),
})

/**
 * 读取提问信号的问题。
 * @param request - 节点记录中的请求负载。
 * @returns 问题；负载不是提问信号时为 undefined。
 */
export function requestQuestions(request: JsonValue): AskUserQuestionItem[] | undefined {
  const parsed = questionsRequestSchema.safeParse(request)
  return parsed.success ? parsed.data.questions as AskUserQuestionItem[] : undefined
}

/**
 * 校验提问信号收到的答案。节点执行器把它用作 `validateSignal`，使格式错误在写入前被拒绝。
 * @param request - 节点记录中的请求负载。
 * @param result - 送达的答案。
 * @returns 可持久化的答案副本。
 */
export function validateQuestionsSignal(request: JsonValue, result: unknown): JsonValue {
  const questions = requestQuestions(request)
  if (questions === undefined) throw new TypeError('请求不是 questions 信号')
  return parseAnswer(questions, result) as unknown as JsonValue
}

const answerSchema = z.object({
  answers: z.array(z.object({
    id: z.string().min(1),
    selected: z.array(z.string()),
    custom: z.string().optional(),
  })),
})

/**
 * 按问题校验答案，返回可持久化的答案副本。每个问题恰好有一个答案项；所选标签必须是该问题的选项，
 * 单选问题最多选择一个。
 * @param questions - 请求中的问题。
 * @param answer - 待校验的答案。
 * @returns 答案的 JSON 副本，答案项按问题顺序排列。
 */
export function parseAnswer(questions: readonly AskUserQuestionItem[], answer: unknown): AskUserQuestionAnswer {
  const parsed = answerSchema.safeParse(answer)
  if (!parsed.success) throw new TypeError(`答案必须为 { answers: [{ id, selected, custom? }] }: ${parsed.error.message}`)
  const byId = new Map<string, AskUserQuestionAnswerItem>()
  for (const item of parsed.data.answers as AskUserQuestionAnswerItem[]) {
    if (byId.has(item.id)) throw new TypeError(`问题 "${item.id}" 有多个答案项`)
    byId.set(item.id, item)
  }
  const answers = questions.map((question) => {
    const item = byId.get(question.id)
    if (item === undefined) throw new TypeError(`缺少问题 "${question.id}" 的答案`)
    byId.delete(question.id)
    const labels = new Set((question.options ?? []).map(option => option.label))
    const unknown = item.selected.filter(label => !labels.has(label))
    if (unknown.length > 0) throw new TypeError(`问题 "${question.id}" 没有选项 ${unknown.map(label => `"${label}"`).join(', ')}`)
    if (question.multiSelect !== true && item.selected.length > 1) {
      throw new TypeError(`问题 "${question.id}" 为单选`)
    }
    return item
  })
  const extra = [...byId.keys()]
  if (extra.length > 0) throw new TypeError(`答案包含未知问题 ${extra.map(id => `"${id}"`).join(', ')}`)
  return { answers }
}

/**
 * 答案是否批准：问题的唯一选择为 {@link APPROVE_LABEL} 且没有自定义文本。
 * @param answer - 请求的答案。
 * @param questionId - 批准/拒绝问题的 ID。
 */
export function isApproved(answer: AskUserQuestionAnswer, questionId: string): boolean {
  const item = answer.answers.find(entry => entry.id === questionId)
  return item?.selected[0] === APPROVE_LABEL && item.custom === undefined
}

/**
 * 回答人为问题填写的非空自定义文本。
 * @param answer - 请求的答案。
 * @param questionId - 问题 ID。
 * @returns 去除首尾空白的文本，或 undefined。
 */
export function answerComment(answer: AskUserQuestionAnswer, questionId: string): string | undefined {
  const comment = answer.answers.find(entry => entry.id === questionId)?.custom?.trim()
  return comment === '' ? undefined : comment
}

function requireText(value: string, path: string): string {
  if (value.trim() === '') throw new TypeError(`${path} 必须为非空字符串`)
  return value
}
