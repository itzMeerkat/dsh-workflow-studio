/** Side panel holding everything that belongs to the workflow rather than to one node. */

import { Button, IconCloseOutlineRegular, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import { CODE_LANGUAGES, languageOf, withSignatures, type AtomLibrary } from '../shared/language.ts'
import type { DagWorkflowDefinition, PortDefinition, PortType } from '../shared/types.ts'
import { workflowInputPorts, workflowOutputPorts } from '../shared/workflow-boundary.ts'
import { AtomFolderDialog } from './AtomFolderDialog.tsx'
import type { Translate, WorkflowStudioKey } from './locale.ts'
import type { WorkflowStudioRemoteNamespace } from './remote.ts'
import {
  appendWorkflowPort,
  formatWorkflowPortDefault,
  parseWorkflowPortDefault,
  removeWorkflowPort,
  setWorkflowPortDefault,
  updateWorkflowPort,
  withWorkflowPorts,
  workflowPortFault,
  WORKFLOW_PORT_TYPES,
  type WorkflowPortEdit,
  type WorkflowPortSide,
} from './workflow-ports.ts'
import css from './WorkflowStudioPanel.module.css'

const FAULT: Record<'empty' | 'duplicate', WorkflowStudioKey> = {
  empty: 'workflowPorts.unnamed',
  duplicate: 'workflowPorts.duplicate',
}

/**
 * The workflow's description, its language and atom folder when it is a code workflow, and the
 * inputs and outputs it declares.
 * @param definition - The workflow being edited.
 * @param library - The atoms read from its atom folder, which give atom nodes their ports.
 * @param remote - The `workflowStudio` Remote, which lists Host folders for the folder dialog.
 * @param t - Translate.
 * @param onChange - Receives the edited workflow.
 * @param onClose - Hides the panel.
 */
export function WorkflowSettings({ definition, library, remote, t, onChange, onClose }: {
  readonly definition: DagWorkflowDefinition
  readonly library: AtomLibrary | undefined
  readonly remote: WorkflowStudioRemoteNamespace
  readonly t: Translate
  readonly onChange: (definition: DagWorkflowDefinition) => void
  readonly onClose: () => void
}) {
  const [folderPrompt, setFolderPrompt] = useState(false)
  const atomSyntax = languageOf(definition).functions?.atoms
  const setFolder = (folder: string | undefined): void => {
    const { atomFolder: _previous, ...rest } = definition
    onChange(folder === undefined ? rest : { ...rest, atomFolder: folder })
  }
  return (
    <aside className={css.settingsPanel} aria-label={t('settings.title')}>
      <div className={css.detailsHeader}>
        <h2>{t('settings.title')}</h2>
        <button
          type="button"
          className={css.detailsClose}
          aria-label={t('settings.close')}
          title={t('settings.close')}
          onClick={onClose}
        >
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>
      <div className={css.settingsContent}>
        <label className={css.settingsField}>
          <span>{t('settings.description')}</span>
          <DraftField
            multiline
            value={definition.description ?? ''}
            label={t('settings.description')}
            onCommit={(text) => {
              const { description: _previous, ...rest } = definition
              onChange(text.trim() === '' ? rest : { ...rest, description: text })
            }}
          />
        </label>
        {definition.kind === 'code' && (
          <>
            <label className={css.settingsField}>
              <span>{t('source.language')}</span>
              <select
                value={definition.language}
                onChange={(event) => {
                  // A language that cannot read atoms has no atom folder.
                  const next: DagWorkflowDefinition = { ...definition, language: event.currentTarget.value }
                  const { atomFolder: _dropped, ...withoutFolder } = next
                  onChange(withSignatures(
                    languageOf(next).functions?.atoms === undefined ? withoutFolder : next,
                    library?.atoms ?? new Map(),
                  ))
                }}
              >
                {CODE_LANGUAGES.map(({ name }) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <div className={css.settingsField}>
              <span>{t('atoms.title')}</span>
              {atomSyntax === undefined
                ? <small>{t('settings.noAtoms')}</small>
                : (
                  <>
                    <code title={definition.atomFolder}>{definition.atomFolder ?? t('settings.noFolder')}</code>
                    {library !== undefined && (
                      <small>{library.atoms.size} {t('atoms.files')}{library.faults.length > 0 && ` · ${library.faults.length} ${t('settings.notAtoms')}`}</small>
                    )}
                    <div className={css.settingsActions}>
                      <Button size="sm" variant="outline" onClick={() => { setFolderPrompt(true) }}>{t('settings.chooseFolder')}</Button>
                      {definition.atomFolder !== undefined && (
                        <Button size="sm" variant="outline" onClick={() => { setFolder(undefined) }}>{t('atoms.clear')}</Button>
                      )}
                    </div>
                  </>
                )}
            </div>
          </>
        )}
        {(['inputs', 'outputs'] as const).map(side => (
          <PortList
            key={side}
            side={side}
            ports={side === 'inputs' ? workflowInputPorts(definition) : workflowOutputPorts(definition)}
            t={t}
            onChange={(ports, edit) => { onChange(withWorkflowPorts(definition, side, ports, edit)) }}
          />
        ))}
      </div>
      {folderPrompt && atomSyntax !== undefined && (
        <AtomFolderDialog
          folder={definition.atomFolder}
          extension={atomSyntax.extension}
          remote={remote}
          t={t}
          onCancel={() => { setFolderPrompt(false) }}
          onChoose={(folder) => {
            setFolderPrompt(false)
            setFolder(folder)
          }}
        />
      )}
    </aside>
  )
}

/** The ports one side of the workflow declares, each with its name, type and, for an input, default. */
function PortList({ side, ports, t, onChange }: {
  readonly side: WorkflowPortSide
  readonly ports: readonly PortDefinition[]
  readonly t: Translate
  readonly onChange: (ports: readonly PortDefinition[], edit: WorkflowPortEdit) => void
}) {
  const isInput = side === 'inputs'
  return (
    <section className={css.settingsPorts} data-side={side}>
      <div className={css.settingsPortsHeader}>
        <h3>{t(isInput ? 'workflowPorts.inputs' : 'workflowPorts.outputs')}</h3>
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
                  onChange(updateWorkflowPort(ports, index, { type: event.currentTarget.value as PortType }), { kind: 'other' })
                }}
              >
                {WORKFLOW_PORT_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
              </select>
              {isInput && (
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
function DraftField({ value, label, onCommit, multiline = false, placeholder, title }: {
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
