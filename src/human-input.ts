/**
 * 节点人工输入的问题与答案校验。
 *
 * 问题与答案使用 Harness `dsh-user-questions` 的格式：问题可带选项、多选和展示意图，
 * 答案按问题 ID 给出所选选项标签和可选的自定义文本。
 * @module dsh-workflow-studio
 */

import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions/types'
import { toJsonValue } from './json.ts'
import type { DagNodeDefinition } from './types.ts'

/** 引擎保留的请求 ID 前缀；节点自身的请求 ID 不得使用。 */
export const RESERVED_REQUEST_PREFIX = 'dsh.'

/** `requiresHumanInput` 节点执行前确认请求的 ID。 */
export const CONFIRM_REQUEST_ID = 'dsh.confirm'

/** 确认请求中唯一问题的 ID。 */
export const CONFIRM_QUESTION_ID = 'decision'

/** 批准执行的选项标签。 */
export const CONFIRM_APPROVE = '批准'

/** 拒绝执行的选项标签。 */
export const CONFIRM_REJECT = '拒绝'

/**
 * `requiresHumanInput` 节点执行前的确认问题。
 * @param node - 待确认的节点。
 * @returns 一个批准/拒绝单选问题。
 */
export function confirmQuestions(node: DagNodeDefinition): AskUserQuestionItem[] {
  return [{
    id: CONFIRM_QUESTION_ID,
    header: '执行确认',
    question: `是否执行节点 ${node.label ?? node.id}？`,
    detail: `节点 ID: ${node.id}\n节点类型: ${node.type}`,
    options: [{ label: CONFIRM_APPROVE }, { label: CONFIRM_REJECT }],
  }]
}

/**
 * 答案是否批准：问题的唯一选择为 {@link CONFIRM_APPROVE} 且没有自定义文本。
 * @param answer - 请求的答案。
 * @param questionId - 批准/拒绝问题的 ID。
 */
export function isApproved(answer: AskUserQuestionAnswer, questionId: string): boolean {
  const item = answer.answers.find(entry => entry.id === questionId)
  return item?.selected[0] === CONFIRM_APPROVE && item.custom === undefined
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

/**
 * 确认答案是否批准执行；拒绝时返回写入节点记录的失败原因。
 * @param answer - 确认请求的答案。
 * @returns 批准时为 undefined，否则为失败原因。
 */
export function confirmRejection(answer: AskUserQuestionAnswer): string | undefined {
  if (isApproved(answer, CONFIRM_QUESTION_ID)) return undefined
  const comment = answerComment(answer, CONFIRM_QUESTION_ID)
  return comment === undefined ? '人工拒绝执行' : `人工拒绝执行: ${comment}`
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${path} 必须为非空字符串`)
  return value
}

/**
 * 校验节点提交的请求 ID 和问题，返回可持久化的问题副本。
 * @param requestId - 节点内唯一的请求 ID。
 * @param questions - 待提问的问题。
 * @param allowReserved - 是否允许引擎保留的请求 ID。
 * @returns 问题的 JSON 副本。
 */
export function parseQuestions(requestId: unknown, questions: unknown, allowReserved = false): AskUserQuestionItem[] {
  const id = nonEmptyString(requestId, 'requestId')
  if (!allowReserved && id.startsWith(RESERVED_REQUEST_PREFIX)) {
    throw new TypeError(`requestId 不得以 "${RESERVED_REQUEST_PREFIX}" 开头`)
  }
  if (!Array.isArray(questions) || questions.length === 0) throw new TypeError('questions 必须为非空数组')
  const ids = new Set<string>()
  questions.forEach((question: unknown, index) => {
    const path = `questions[${index}]`
    if (question === null || typeof question !== 'object') throw new TypeError(`${path} 必须为对象`)
    const item = question as Partial<AskUserQuestionItem>
    const questionId = nonEmptyString(item.id, `${path}.id`)
    if (ids.has(questionId)) throw new TypeError(`问题 ID "${questionId}" 重复`)
    ids.add(questionId)
    nonEmptyString(item.question, `${path}.question`)
    const labels = new Set<string>()
    for (const option of item.options ?? []) {
      const label = nonEmptyString(option.label, `${path}.options[].label`)
      if (labels.has(label)) throw new TypeError(`问题 "${questionId}" 的选项 "${label}" 重复`)
      labels.add(label)
    }
  })
  return toJsonValue(questions, 'questions') as unknown as AskUserQuestionItem[]
}

/**
 * 按问题校验答案，返回可持久化的答案副本。每个问题恰好有一个答案项；所选标签必须是该问题的选项，
 * 单选问题最多选择一个。
 * @param questions - 请求中的问题。
 * @param answer - 待校验的答案。
 * @returns 答案的 JSON 副本，答案项按问题顺序排列。
 */
export function parseAnswer(questions: readonly AskUserQuestionItem[], answer: unknown): AskUserQuestionAnswer {
  if (answer === null || typeof answer !== 'object' || !Array.isArray((answer as AskUserQuestionAnswer).answers)) {
    throw new TypeError('答案必须为 { answers: [...] }')
  }
  const byId = new Map<string, AskUserQuestionAnswerItem>()
  for (const raw of (answer as AskUserQuestionAnswer).answers as unknown[]) {
    if (raw === null || typeof raw !== 'object') throw new TypeError('答案项必须为对象')
    const item = raw as Partial<AskUserQuestionAnswerItem>
    const id = nonEmptyString(item.id, '答案项 id')
    if (byId.has(id)) throw new TypeError(`问题 "${id}" 有多个答案项`)
    if (!Array.isArray(item.selected) || item.selected.some(label => typeof label !== 'string')) {
      throw new TypeError(`问题 "${id}" 的 selected 必须为字符串数组`)
    }
    if (item.custom !== undefined && typeof item.custom !== 'string') {
      throw new TypeError(`问题 "${id}" 的 custom 必须为字符串`)
    }
    byId.set(id, {
      id,
      selected: [...item.selected],
      ...(item.custom === undefined ? {} : { custom: item.custom }),
    })
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
