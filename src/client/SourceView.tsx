/** The edited graph written out in its workflow's language. */

import { useMemo } from 'react'
import type { WorkflowIr } from '../shared/ir.ts'
import type { Callees } from '../shared/callees.ts'
import type { Language } from '../shared/language.ts'
import { RenderError, renderWorkflow, type RenderFault } from '../shared/source.ts'
import type { Translate } from './locale.ts'
import css from './WorkflowStudioPanel.module.css'

/**
 * Render the unsaved graph on every edit; nothing here waits for a save or the Host.
 * @param ir - The graph's IR, or undefined when the graph cannot be analyzed.
 * @param language - The workflow's language.
 * @param callees - The atoms and workflows the graph's nodes call.
 * @param t - Translate.
 */
export function SourceView({ ir, language, callees, t }: {
  readonly ir: WorkflowIr | undefined
  readonly language: Language
  readonly callees: Callees
  readonly t: Translate
}) {
  const output = useMemo(() => ir === undefined ? undefined : render(ir, language, callees), [ir, language, callees])
  return (
    <section className={css.source}>
      {output === undefined && <p className={css.diagnosticsEmpty}>{t('source.unavailable')}</p>}
      {output !== undefined && 'fault' in output && (
        <p className={css.notice} role="alert">
          <code>{output.fault.node}</code> {'port' in output.fault && <code>{output.fault.port}</code>}
          {'atom' in output.fault && <code>{output.fault.atom}</code>}
          {'workflow' in output.fault && <code>{output.fault.workflow}</code>}
          {' '}{t(`source.fault.${output.fault.code}`)}
        </p>
      )}
      {output !== undefined && 'text' in output && <pre>{output.text}</pre>}
    </section>
  )
}

/** The source, or the fault the language cannot write. */
function render(ir: WorkflowIr, language: Language, callees: Callees): { text: string } | { fault: RenderFault } {
  try {
    return { text: renderWorkflow(ir, language, callees) }
  } catch (error: unknown) {
    if (error instanceof RenderError) return { fault: error.fault }
    throw error
  }
}
