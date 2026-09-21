/** Dialog that collects values for a workflow's declared inputs before a run starts. */

import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import type { PortDefinition } from '../shared/types.ts'
import type { Translate } from './locale.ts'
import { workflowRunDefaults, workflowRunInputs } from './workflow-ports.ts'
import css from './WorkflowStudioPanel.module.css'

/**
 * Ask for the run's input values.
 * @param ports - The workflow's declared input ports; every field starts at its default.
 * @param busy - Whether a run is already starting.
 * @param t - Translator for the dialog's copy.
 * @param onCancel - Closes the dialog without starting a run.
 * @param onRun - Receives the values encoded as a JSON object.
 */
export function RunDialog({
  ports,
  busy,
  t,
  onCancel,
  onRun,
}: {
  readonly ports: readonly PortDefinition[]
  readonly busy: boolean
  readonly t: Translate
  readonly onCancel: () => void
  readonly onRun: (inputs: string) => void
}) {
  const [typed, setTyped] = useState(() => workflowRunDefaults(ports))
  const parsed = workflowRunInputs(ports, typed)
  const fault = 'fault' in parsed ? parsed.fault : undefined
  return (
    <Modal
      open
      title={t('run.title')}
      description={t('run.description')}
      closeLabel={t('run.close')}
      onClose={onCancel}
      footer={(
        <div className={css.runActions}>
          <Button size="sm" variant="outline" onClick={onCancel}>{t('run.cancel')}</Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || fault !== undefined}
            onClick={() => { if ('values' in parsed) onRun(JSON.stringify(parsed.values)) }}
          >
            {t('run.start')}
          </Button>
        </div>
      )}
    >
      <div className={css.runForm}>
        {ports.map((port) => {
          const failed = fault?.name === port.name ? fault : undefined
          return (
            <label
              key={port.name}
              className={css.runField}
              {...(failed === undefined ? {} : { 'data-fault': failed.kind })}
            >
              <span>
                {port.name}
                <small>{port.type}</small>
              </span>
              <input
                value={typed[port.name] ?? ''}
                placeholder={port.default === undefined ? t('run.required') : undefined}
                onChange={(event) => {
                  const value = event.currentTarget.value
                  setTyped(current => ({ ...current, [port.name]: value }))
                }}
              />
              {failed !== undefined && (
                <small>{t(failed.kind === 'missing' ? 'run.required' : 'run.invalid')}</small>
              )}
            </label>
          )
        })}
      </div>
    </Modal>
  )
}
