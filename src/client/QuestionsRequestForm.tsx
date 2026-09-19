/** Built-in renderer for `questions` requests: one form per waiting request. */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { useState } from 'react'
import { requestQuestions } from '../shared/questions.ts'
import type { JsonValue } from '../shared/types.ts'
import type { NS, Translate } from './locale.ts'
import { buildAnswer, isAnswerComplete, type AnswerDraft } from './runs-model.ts'
import type { RequestViewProps } from './slot-contract.ts'
import css from './WorkflowStudioPanel.module.css'

type QuestionsRequestFormProps = RequestViewProps & PropsLocale<typeof NS>

/** Ask the questions of one waiting request and deliver the answer. */
export function QuestionsRequestForm({
  nodeId,
  nodeLabel,
  requestId,
  request,
  busy,
  submit,
  t,
}: QuestionsRequestFormProps) {
  const [draft, setDraft] = useState<AnswerDraft>({ selected: {}, custom: {} })
  const questions = requestQuestions(request)
  // A node may carry the `questions` kind with a payload this form cannot read.
  if (questions === undefined) return <RawRequest request={request} nodeLabel={nodeLabel} t={t} />

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
        // 答案是 JSON 对象；声明类型没有索引签名，断言只让它满足 JsonValue。
        submit(buildAnswer(questions, draft) as unknown as JsonValue)
      }}
    >
      <p className={css.questionSource}>{t('questions.title')} · {t('questions.from')} {nodeLabel}</p>
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
                  name={`${nodeId}/${requestId}/${question.id}`}
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

/** Show the payload of a request no registered component renders. */
export function RawRequest({
  request,
  nodeLabel,
  t,
}: {
  readonly request: JsonValue
  readonly nodeLabel: string
  readonly t: Translate
}) {
  return (
    <div className={css.questionCard}>
      <p className={css.questionSource}>{t('requests.title')} · {t('questions.from')} {nodeLabel}</p>
      <strong>{t('requests.payload')}</strong>
      <pre>{JSON.stringify(request, null, 2)}</pre>
    </div>
  )
}
