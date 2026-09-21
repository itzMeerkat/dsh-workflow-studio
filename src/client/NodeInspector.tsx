/** Details panel for the selected canvas node: label, configuration JSON, and the latest run result. */

import { Button, IconCloseOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkflowFlowNode } from './graph-model.ts'
import type { Translate } from './locale.ts'
import css from './WorkflowStudioPanel.module.css'

/** Render the settings of one selected node. */
export function NodeInspector({
  node,
  configSource,
  runResult,
  t,
  onLabel,
  onConfigSource,
  onApplyConfig,
  onDelete,
  onClose,
}: {
  readonly node: WorkflowFlowNode
  /** Configuration JSON as the user is typing it; applied only by `onApplyConfig`. */
  readonly configSource: string
  readonly runResult: string | undefined
  readonly t: Translate
  readonly onLabel: (label: string) => void
  readonly onConfigSource: (source: string) => void
  readonly onApplyConfig: () => void
  readonly onDelete: () => void
  readonly onClose: () => void
}) {
  return (
    <section className={css.detailsPanel}>
      <div className={css.detailsHeader}>
        <h2>{t('inspector.title')}</h2>
        <button
          type="button"
          className={css.detailsClose}
          aria-label={t('inspector.close')}
          title={t('inspector.close')}
          onClick={onClose}
        >
          <IconCloseOutline16 size={14} />
        </button>
      </div>
      <div className={css.detailsContent}>
        <section>
          <div className={css.inspectorForm}>
            <div className={css.inspectorIdentity}>
              <span>{t('inspector.nodeId')}</span>
              <code>{node.data.definition.id}</code>
            </div>
            <label>
              <span>{t('inspector.label')}</span>
              <input
                value={node.data.definition.label ?? ''}
                placeholder={node.data.catalog?.label ?? node.data.definition.type}
                onChange={event => { onLabel(event.currentTarget.value) }}
              />
            </label>
            <label>
              <span>{t('inspector.config')}</span>
              <textarea
                aria-label={t('inspector.config')}
                spellCheck={false}
                value={configSource}
                onChange={event => { onConfigSource(event.currentTarget.value) }}
              />
            </label>
            <div className={css.inspectorActions}>
              <Button size="sm" variant="outline" onClick={onApplyConfig}>
                {t('action.apply')}
              </Button>
              <Button size="sm" variant="outline" icon={<IconTrashOutline16 size={14} />} onClick={onDelete}>
                {t('action.delete')}
              </Button>
            </div>
          </div>
        </section>
        <section className={css.resultPanel}>
          <h2>{t('node.output')}</h2>
          {runResult === undefined ? <p>{t('result.empty')}</p> : <pre>{runResult}</pre>}
        </section>
      </div>
    </section>
  )
}
