/**
 * `human-approval` 节点：暂停工作流中的这一步，直到有人批准或拒绝。
 * @module dsh-workflow-studio/nodes
 */

import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { CONFIRM_APPROVE, CONFIRM_REJECT } from '../human-input.ts'
import { NodeFailure, WorkflowNode, type WorkflowNodePorts } from '../node.ts'
import type { NodeControlDefinition, NodeExecutionContext } from '../types.ts'

/** 审批请求的请求 ID；节点被重新调用时复用同一请求。 */
export const APPROVAL_REQUEST_ID = 'approval'

/** 审批请求中唯一问题的 ID。 */
export const APPROVAL_QUESTION_ID = 'decision'

/** 未配置问题时使用的问题文本。 */
export const DEFAULT_APPROVAL_QUESTION = '是否批准继续执行？'

/** 审批详情中输入值 JSON 的最大字符数。 */
const DETAIL_LIMIT = 4000

type RejectMode = 'fail' | 'branch'

type ApprovalOutputs =
  | { approved: true; output?: unknown; comment?: string }
  | { rejected: true; comment?: string }

/** 解析的审批答案。 */
interface Decision {
  readonly approved: boolean
  readonly comment?: string
}

function decide(answer: AskUserQuestionAnswer): Decision {
  const item = answer.answers.find(entry => entry.id === APPROVAL_QUESTION_ID)
  const comment = item?.custom?.trim()
  const withComment = comment === undefined || comment === '' ? {} : { comment }
  return { approved: item?.selected[0] === CONFIRM_APPROVE && item.custom === undefined, ...withComment }
}

function inputDetail(context: NodeExecutionContext): string | undefined {
  if (!Object.hasOwn(context.inputs, 'input')) return undefined
  const json = JSON.stringify(context.inputs.input, null, 2)
  return json.length <= DETAIL_LIMIT ? json : `${json.slice(0, DETAIL_LIMIT)}\n…`
}

/**
 * 请人批准后再继续。批准时输出 `approved` 信号并原样传递 `input`；拒绝时按 `onReject`
 * 使节点失败，或输出 `rejected` 信号。自定义文本回答视为拒绝，其文本作为 `comment`。
 */
export class HumanApprovalNode extends WorkflowNode<ApprovalOutputs> {
  readonly type = 'human-approval'
  readonly label = '人工审批'
  readonly description = '等待人工批准或拒绝；批准后传递输入并输出 approved 信号'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [
      { name: 'input', type: 'any', description: '展示给审批人的值；批准后原样输出', required: false },
    ],
    outputs: [
      { name: 'approved', type: 'boolean', description: '批准时为 true', display: 'value' },
      { name: 'output', type: 'any', description: '批准时传递的输入值', display: 'json' },
      { name: 'rejected', type: 'boolean', description: '拒绝且 onReject 为 branch 时为 true', display: 'value' },
      { name: 'comment', type: 'string', description: '审批人填写的自定义说明', display: 'value' },
    ],
  }
  override readonly controls: readonly NodeControlDefinition[] = [
    {
      name: 'question',
      label: '问题',
      kind: 'text',
      defaultValue: DEFAULT_APPROVAL_QUESTION,
      placeholder: DEFAULT_APPROVAL_QUESTION,
    },
    {
      name: 'onReject',
      label: '拒绝时',
      kind: 'select',
      defaultValue: 'fail',
      options: [
        { label: '节点失败', value: 'fail' },
        { label: '输出 rejected 分支', value: 'branch' },
      ],
    },
  ]

  protected async run(context: NodeExecutionContext): Promise<ApprovalOutputs> {
    const question = context.config.question ?? DEFAULT_APPROVAL_QUESTION
    if (typeof question !== 'string' || question.trim() === '') {
      throw new NodeFailure('question 必须为非空字符串')
    }
    const onReject = context.config.onReject ?? 'fail'
    if (onReject !== 'fail' && onReject !== 'branch') {
      throw new NodeFailure('onReject 必须为 fail 或 branch')
    }
    const detail = inputDetail(context)
    const item: AskUserQuestionItem = {
      id: APPROVAL_QUESTION_ID,
      header: '人工审批',
      question,
      ...(detail === undefined ? {} : { detail }),
      options: [{ label: CONFIRM_APPROVE }, { label: CONFIRM_REJECT }],
    }
    const decision = decide(await context.askHuman(APPROVAL_REQUEST_ID, [item]))
    const comment = decision.comment === undefined ? {} : { comment: decision.comment }
    if (decision.approved) {
      return Object.hasOwn(context.inputs, 'input')
        ? { approved: true, output: context.inputs.input, ...comment }
        : { approved: true, ...comment }
    }
    if ((onReject as RejectMode) === 'branch') return { rejected: true, ...comment }
    throw new NodeFailure(
      decision.comment === undefined ? '审批被拒绝' : `审批被拒绝: ${decision.comment}`,
      comment,
    )
  }
}
