/**
 * The slot a node plugin fills to render its own waiting request.
 *
 * A node declares what it waits for with `context.awaitSignal(requestId, request)`; the Runs tab
 * dispatches on the request payload's `kind` field and renders the entry registered for it.
 * Studio registers the built-in `questions` form; a plugin merges this contract with `import type`
 * and registers its own key through `ctx.slots`, never importing this package at runtime.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { JsonValue } from '../shared/types.ts'

/** One request still waiting for its result. */
export interface RequestViewProps {
  readonly runId: string
  readonly nodeId: string
  /** The node's label in the run's definition snapshot. */
  readonly nodeLabel: string
  /** The node type that declared the request. */
  readonly nodeType: string
  readonly requestId: string
  /** The payload the node passed to `awaitSignal`. */
  readonly request: JsonValue
  /** Another result is being delivered; controls stay disabled until it settles. */
  readonly busy: boolean
  /** Deliver the result the node is waiting for. */
  readonly submit: (result: JsonValue) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * One waiting request, keyed by its payload's `kind`. An unclaimed kind falls back to the
     * raw payload, so a node that raises a request nobody renders stays visible and answerable
     * through the Host Remote.
     */
    'workflowStudio.request': { kind: 'keyed'; scope: 'root'; owner: RequestViewProps }
  }
}
