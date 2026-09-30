/** Side panel holding everything that belongs to the workflow rather than to one node. */

import { Button, IconCloseOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { CODE_LANGUAGES, languageOf, portTypes } from '../shared/language.ts'
import { withCallees, type Callees } from '../shared/callees.ts'
import type { DagWorkflowDefinition } from '../shared/types.ts'
import { workflowInputPorts, workflowOutputPorts } from '../shared/workflow-boundary.ts'
import type { Translate } from './locale.ts'
import { DraftField, PortList } from './PortList.tsx'
import { withWorkflowPorts } from './workflow-ports.ts'
import css from './WorkflowStudioPanel.module.css'

/**
 * The workflow's description, its language when it is a code workflow, and the inputs and outputs it declares.
 * @param definition - The workflow being edited.
 * @param callees - What the workflow's nodes call, which gives those nodes their ports again after a language change; the
 * types its atoms use are the types a port may declare.
 * @param t - Translate.
 * @param onChange - Receives the edited workflow.
 * @param onClose - Hides the panel.
 * @param onDelete - Deletes the saved workflow; absent for one not yet saved.
 */
export function WorkflowSettings({ definition, callees, t, onChange, onClose, onDelete }: {
  readonly definition: DagWorkflowDefinition
  readonly callees: Callees
  readonly t: Translate
  readonly onChange: (definition: DagWorkflowDefinition) => void
  readonly onClose: () => void
  readonly onDelete: (() => void) | undefined
}) {
  const language = languageOf(definition)
  const types = portTypes(callees.atoms)
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
          <label className={css.settingsField}>
            <span>{t('source.language')}</span>
            <select
              value={definition.language}
              onChange={(event) => { onChange(withCallees({ ...definition, language: event.currentTarget.value }, callees)) }}
            >
              {CODE_LANGUAGES.map(({ name }) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        )}
        {(['inputs', 'outputs'] as const).map(side => (
          <PortList
            key={side}
            title={t(side === 'inputs' ? 'workflowPorts.inputs' : 'workflowPorts.outputs')}
            side={side}
            ports={side === 'inputs' ? workflowInputPorts(definition) : workflowOutputPorts(definition)}
            types={types}
            language={language}
            // A code workflow is compiled, never run, so nothing would read a default.
            defaults={side === 'inputs' && definition.kind === 'run'}
            t={t}
            onChange={(ports, edit) => { onChange(withWorkflowPorts(definition, side, ports, edit)) }}
          />
        ))}
        {onDelete !== undefined && (
          <Button
            size="sm"
            variant="outline"
            icon={<IconTrashOutlineRegular size={14} />}
            onClick={() => { if (window.confirm(t('settings.deleteConfirm'))) onDelete() }}
          >
            {t('settings.delete')}
          </Button>
        )}
      </div>
    </aside>
  )
}
