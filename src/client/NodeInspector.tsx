/** Details panel for the selected canvas node: label, own ports, configuration JSON, and the latest run result. */

import { Button, IconCloseOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Language } from '../shared/language.ts'
import type { PortDefinition, PortType } from '../shared/types.ts'
import { nodeInputPorts, nodeOutputPorts, type WorkflowFlowNode } from './graph-model.ts'
import type { Translate } from './locale.ts'
import { PortList } from './PortList.tsx'
import type { WorkflowPortEdit, WorkflowPortSide } from './workflow-ports.ts'
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
  ports,
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
  /** The sides whose ports the author declares, and how to change them; absent for a node that has none. */
  readonly ports?: {
    readonly sides: readonly WorkflowPortSide[]
    readonly types: readonly PortType[]
    readonly language: Language
    readonly onChange: (side: WorkflowPortSide, ports: readonly PortDefinition[], edit: WorkflowPortEdit) => void
  }
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
          <IconCloseOutlineRegular size={14} />
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
            {ports?.sides.map(side => (
              <PortList
                key={side}
                title={t(side === 'inputs' ? 'nodePorts.inputs' : 'nodePorts.outputs')}
                side={side}
                ports={side === 'inputs' ? nodeInputPorts(node.data) : nodeOutputPorts(node.data)}
                types={ports.types}
                language={ports.language}
                defaults={false}
                t={t}
                onChange={(next, edit) => { ports.onChange(side, next, edit) }}
              />
            ))}
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
              <Button size="sm" variant="outline" icon={<IconTrashOutlineRegular size={14} />} onClick={onDelete}>
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
