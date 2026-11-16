/** The edited graph written out as its pseudocode description. */

import { useMemo } from 'react'
import { describeWorkflow } from '../shared/description.ts'
import type { WorkflowIr } from '../shared/ir.ts'
import type { WorkflowLookup } from '../shared/subworkflow.ts'
import type { Translate } from './locale.ts'
import css from './WorkflowStudioPanel.module.css'

/**
 * Describe the unsaved graph on every edit; nothing here waits for a save or the Host.
 * @param ir - The graph's IR, or undefined when the graph cannot be analyzed.
 * @param workflows - Reads the saved workflows its subworkflow nodes embed.
 * @param t - Translate.
 */
export function DescriptionView({ ir, workflows, t }: {
  readonly ir: WorkflowIr | undefined
  readonly workflows: WorkflowLookup
  readonly t: Translate
}) {
  const text = useMemo(() => ir === undefined ? undefined : describeWorkflow(ir, workflows), [ir, workflows])
  return (
    <section className={css.description}>
      {text === undefined
        ? <p className={css.diagnosticsEmpty}>{t('description.unavailable')}</p>
        : <pre>{text}</pre>}
    </section>
  )
}
