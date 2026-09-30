/** Editing a list of declared ports, and the text field that commits a draft. */

import { IconCloseOutlineRegular, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import { typeName, type Language } from '../shared/language.ts'
import type { PortDefinition, PortType } from '../shared/types.ts'
import type { Translate, WorkflowStudioKey } from './locale.ts'
import {
  appendWorkflowPort,
  formatWorkflowPortDefault,
  parseWorkflowPortDefault,
  removeWorkflowPort,
  setWorkflowPortDefault,
  updateWorkflowPort,
  workflowPortFault,
  type WorkflowPortEdit,
  type WorkflowPortSide,
} from './workflow-ports.ts'
import css from './WorkflowStudioPanel.module.css'

const FAULT: Record<'empty' | 'duplicate', WorkflowStudioKey> = {
  empty: 'workflowPorts.unnamed',
  duplicate: 'workflowPorts.duplicate',
}

/**
 * The ports one side of a workflow or a node declares, each with its name, type and, when `defaults` is set, default.
 * @param title - The list's heading.
 * @param side - Which side the ports are on, which names a new port.
 * @param types - The port types offered; a port keeps a declared type the list lacks.
 */
export function PortList({ title, side, ports, types, language, defaults, t, onChange }: {
  readonly title: string
  readonly side: WorkflowPortSide
  readonly ports: readonly PortDefinition[]
  readonly types: readonly PortType[]
  readonly language: Language
  readonly defaults: boolean
  readonly t: Translate
  readonly onChange: (ports: readonly PortDefinition[], edit: WorkflowPortEdit) => void
}) {
  return (
    <section className={css.settingsPorts} {...(defaults ? { 'data-defaults': '' } : {})}>
      <div className={css.settingsPortsHeader}>
        <h3>{title}</h3>
        <button
          type="button"
          className={css.workflowPortsAdd}
          aria-label={t('workflowPorts.add')}
          title={t('workflowPorts.add')}
          onClick={() => { onChange(appendWorkflowPort(ports, side), { kind: 'other' }) }}
        >
          <IconPlusOutlineRegular size={13} />
        </button>
      </div>
      {ports.length === 0 && <small>{t('workflowPorts.empty')}</small>}
      <ul>
        {ports.map((port, index) => {
          const fault = workflowPortFault(ports, index)
          return (
            // Rows are identified by position, so a row keeps its place while its name changes.
            <li key={index} className={css.boundaryPort} {...(fault === undefined ? {} : { 'data-fault': fault })}>
              <DraftField
                value={port.name}
                label={t('workflowPorts.name')}
                {...(fault === undefined ? {} : { title: t(FAULT[fault]) })}
                onCommit={(name) => {
                  onChange(updateWorkflowPort(ports, index, { name }), { kind: 'renamed', from: port.name, to: name })
                }}
              />
              <select
                value={port.type}
                aria-label={t('workflowPorts.type')}
                onChange={(event) => {
                  onChange(updateWorkflowPort(ports, index, { type: event.currentTarget.value }), { kind: 'other' })
                }}
              >
                {[...new Set([...types, port.type])].map(type => <option key={type} value={type}>{typeName(language, type)}</option>)}
              </select>
              {defaults && (
                <DraftField
                  value={formatWorkflowPortDefault(port.default, port.type)}
                  label={t('workflowPorts.default')}
                  placeholder={t('workflowPorts.default')}
                  onCommit={(text) => {
                    const parsed = parseWorkflowPortDefault(text, port.type)
                    // A value that is not of the port's type is not a default; the field shows the declared one again.
                    if (parsed !== 'invalid') onChange(setWorkflowPortDefault(ports, index, parsed.value), { kind: 'other' })
                  }}
                />
              )}
              <button
                type="button"
                aria-label={t('workflowPorts.remove')}
                title={t('workflowPorts.remove')}
                onClick={() => { onChange(removeWorkflowPort(ports, index), { kind: 'removed', name: port.name }) }}
              >
                <IconCloseOutlineRegular size={12} />
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * A text field that edits a draft and commits it when the field loses focus or Enter is pressed.
 *
 * Committing on every key would rebuild the canvas and move the wires of a port while its name is
 * half typed. A commit the owner rejects leaves `value` unchanged, and the field shows it again.
 */
export function DraftField({ value, label, onCommit, multiline = false, placeholder, title }: {
  readonly value: string
  readonly label: string
  readonly onCommit: (text: string) => void
  readonly multiline?: boolean
  readonly placeholder?: string
  readonly title?: string
}) {
  const [draft, setDraft] = useState<string>()
  const commit = (): void => {
    if (draft !== undefined && draft !== value) onCommit(draft)
    setDraft(undefined)
  }
  const shared = {
    value: draft ?? value,
    'aria-label': label,
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(title === undefined ? {} : { title }),
    onBlur: commit,
  }
  return multiline
    ? <textarea {...shared} rows={3} onChange={(event) => { setDraft(event.currentTarget.value) }} />
    : (
      <input
        {...shared}
        onChange={(event) => { setDraft(event.currentTarget.value) }}
        onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
      />
    )
}
