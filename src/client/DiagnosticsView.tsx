/** The static-analysis findings for the edited graph, and the summary a node card carries. */

import { DIAGNOSTIC_SEVERITY } from '../shared/analysis.ts'
import type { WorkflowDiagnostic } from '../shared/analysis.ts'
import type { Translate } from './locale.ts'
import css from './WorkflowStudioPanel.module.css'

/**
 * The facts a diagnostic adds to its message, as `端口 input` style pairs.
 * @param diagnostic - One finding.
 * @param t - Translate.
 * @returns The pairs, in the order they help a reader locate the problem.
 */
export function diagnosticDetails(diagnostic: WorkflowDiagnostic, t: Translate): string[] {
  switch (diagnostic.code) {
    case 'starved-input':
    case 'output-gap':
      return [`${t('diagnostics.port')} ${diagnostic.port}`, `${t('diagnostics.pin')} ${diagnostic.pin}`]
    case 'merge-overlap':
      return [diagnostic.sources.join(', ')]
    case 'merge-gap':
      return []
    case 'type-mismatch':
      return [`${t('diagnostics.port')} ${diagnostic.port}`, diagnostic.types.join(' → ')]
    default:
      return assertNever(diagnostic)
  }
}

/** One finding on one line: severity, the node it belongs to, what is wrong, and where. */
function DiagnosticRow({ diagnostic, t }: {
  readonly diagnostic: WorkflowDiagnostic
  readonly t: Translate
}) {
  const severity = DIAGNOSTIC_SEVERITY[diagnostic.code]
  return (
    <li className={css.diagnosticRow}>
      <span className={css.diagnosticSeverity} data-severity={severity}>
        {t(`diagnostics.${severity}`)}
      </span>
      <code className={css.diagnosticNode}>{diagnostic.nodeId}</code>
      <span>{t(`diagnostics.${diagnostic.code}`)}</span>
      {diagnosticDetails(diagnostic, t).map(detail => (
        <span key={detail} className={css.diagnosticDetail}>{detail}</span>
      ))}
    </li>
  )
}

/**
 * Every finding for the edited graph.
 * @param diagnostics - The findings, or undefined when the graph cannot be analyzed.
 * @param t - Translate.
 */
export function DiagnosticsView({ diagnostics, t }: {
  readonly diagnostics: readonly WorkflowDiagnostic[] | undefined
  readonly t: Translate
}) {
  if (diagnostics === undefined) return null
  return (
    <section className={css.diagnostics}>
      <h3>{t('diagnostics.title')}</h3>
      {diagnostics.length === 0
        ? <p className={css.diagnosticsEmpty}>{t('diagnostics.empty')}</p>
        : (
          <ul>
            {diagnostics.map(diagnostic => (
              <DiagnosticRow key={diagnosticKey(diagnostic)} diagnostic={diagnostic} t={t} />
            ))}
          </ul>
        )}
    </section>
  )
}

/** A finding's identity for React: one node raises at most one finding of each code per port. */
function diagnosticKey(diagnostic: WorkflowDiagnostic): string {
  return `${diagnostic.nodeId}/${diagnostic.code}/${'port' in diagnostic ? diagnostic.port : ''}`
}

function assertNever(diagnostic: never): never {
  throw new Error(`Unhandled diagnostic: ${JSON.stringify(diagnostic)}`)
}
