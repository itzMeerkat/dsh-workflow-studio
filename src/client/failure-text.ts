/** The panel's wording of a failed Remote call: a refusal in the active locale, anything else by its own message. */

import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever, messageOf } from '../shared/errors.ts'
import type { WorkflowRefusal } from '../shared/refusal.ts'
import type { Translate, WorkflowStudioKey } from './locale.ts'

/**
 * What the panel says about one failure.
 * @param error - The failure a Remote call returned or threw.
 * @param t - Translate.
 * @returns A refusal worded from the dictionary; any other failure's message, which the Host does not localize because
 * it reports something the author cannot fix.
 */
export function failureText(error: unknown, t: Translate): string {
  const remote = remoteErrorOf(error)
  return remote?.code === 'workflowStudio/refused' ? refusalText(remote.details.refusal, t) : messageOf(error)
}

/**
 * One refusal in the active locale.
 * @param refusal - The refusal the Host reported.
 * @param t - Translate.
 */
export function refusalText(refusal: WorkflowRefusal, t: Translate): string {
  const say = (key: WorkflowStudioKey, values: Readonly<Record<string, string | number | readonly string[]>>): string =>
    t(key).replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = values[name]
      return value === undefined ? match : Array.isArray(value) ? value.join(', ') : String(value)
    })
  switch (refusal.code) {
    case 'name-taken':
      return say('refusal.name-taken', refusal)
    case 'name-taken-by-kind':
      return say('refusal.name-taken-by-kind', { name: refusal.name, kind: t(`kind.${refusal.kind}`) })
    case 'workflow-missing':
      return say('refusal.workflow-missing', refusal)
    case 'kind-change':
      return say('refusal.kind-change', { workflow: refusal.workflow, from: t(`kind.${refusal.from}`), to: t(`kind.${refusal.to}`) })
    case 'embedded':
      return say(`refusal.embedded.${refusal.action}`, refusal)
    case 'not-runnable':
      return say('refusal.not-runnable', refusal)
    case 'run-missing':
      return say('refusal.run-missing', refusal)
    case 'run-ended':
      return say('refusal.run-ended', refusal)
    case 'run-node-missing':
      return say('refusal.run-node-missing', refusal)
    case 'request-missing':
      return say('refusal.request-missing', refusal)
    case 'request-answered':
      return say('refusal.request-answered', refusal)
    case 'result-rejected':
      return say('refusal.result-rejected', refusal)
    case 'input-undeclared':
      return say('refusal.input-undeclared', refusal)
    case 'input-missing':
      return say('refusal.input-missing', refusal)
    case 'embed-cycle':
      return say('refusal.embed-cycle', { trail: refusal.trail.join(' → ') })
    case 'embedded-workflow-missing':
      return say('refusal.embedded-workflow-missing', refusal)
    case 'language-unknown':
      return say('refusal.language-unknown', refusal)
    case 'folder-relative':
      return say('refusal.folder-relative', refusal)
    case 'folder-unreadable':
      return say('refusal.folder-unreadable', refusal)
    case 'atom-folder-invalid':
      return say('refusal.atom-folder-invalid', refusal)
    case 'boundary-duplicate':
      return say(`refusal.boundary-duplicate.${refusal.side}`, refusal)
    case 'node-kind':
      return say('refusal.node-kind', { type: refusal.type, kinds: refusal.kinds.map(kind => t(`kind.${kind}`)), kind: t(`kind.${refusal.kind}`) })
    case 'cycle':
      return say('refusal.cycle', refusal)
    case 'node-duplicate':
      return say('refusal.node-duplicate', refusal)
    case 'node-type-unknown':
      return say('refusal.node-type-unknown', refusal)
    case 'port-duplicate':
      return say(`refusal.port-duplicate.${refusal.side}`, refusal)
    case 'switch-case':
      return say('refusal.switch-case', refusal)
    case 'edge-duplicate':
      return say('refusal.edge-duplicate', refusal)
    case 'edge-node-missing':
      return say(`refusal.edge-node-missing.${refusal.end}`, refusal)
    case 'exec-pin-missing':
      return say(`refusal.exec-pin-missing.${refusal.end}`, refusal)
    case 'exec-edge-duplicate':
      return say('refusal.exec-edge-duplicate', refusal)
    case 'port-missing':
      return say(`refusal.port-missing.${refusal.side}`, refusal)
    case 'port-incompatible':
      return say('refusal.port-incompatible', refusal)
    case 'input-overwired':
      return say('refusal.input-overwired', refusal)
    case 'input-unwired':
      return say('refusal.input-unwired', refusal)
    case 'variadic-min':
      return say('refusal.variadic-min', refusal)
    case 'variadic-input-type':
      return say('refusal.variadic-input-type', refusal)
    case 'variadic-output-type':
      return say('refusal.variadic-output-type', refusal)
    case 'diagnostic':
      return say('refusal.diagnostic', { node: refusal.diagnostic.nodeId, reason: t(`diagnostics.${refusal.diagnostic.code}`) })
    default:
      return assertNever(refusal)
  }
}
