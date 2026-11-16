# Agent Note: Node retry and the failure pin

Status: implemented

## Problem

A failed node failed the whole run. For a timeout from a model or an API that is the wrong answer: calling the node again a moment later usually succeeds, and before this change a node was called again only after a Host restart. For a failure that will not pass, such as a rejected filing, an author had no way to draw what should happen instead, like notifying someone or taking a fallback path; the only outcome was a failed run.

## Decision

**Retry is a node policy.** `retry: { retries, delayMs }` on the node type, overridden by `retry` on a workflow node, lets `RunExecutor.runNode` call a throwing node up to `retries` more times, `delayMs` apart. Only an error the node throws is retried: a missing required input or a result that breaks the output rules recurs on every call, so it fails at once. Between calls the node stays `running` with its last error and its call count written to the run record. A cancel during the wait cancels the node; a run exiting because another node failed stops retrying and keeps the error. A successful retry clears the error.

**Failure is a pin.** Every node that can fail offers `failed` (`EXEC_FAILED_PIN`, `hasFailedPin` in `src/shared/graph.ts`): every node but the boundary nodes, a `subworkflow` node, and the nodes its expansion places. When an execution edge leaves that pin, a failure after the last retry is handled: the node is recorded `failed` with `fired: ['failed']`, its other pins do not fire, and the run continues. Gating reads `fired` for completed and failed nodes alike, so no other scheduling rule changed. Without such an edge a failure ends the run as before. Node types cannot declare a pin named `failed`, and a `switch` case cannot be named `failed`.

**The analysis knows a node's endings.** `outcomes` in `src/shared/analysis.ts` lists the pin sets a node can fire in one ending: one per pin for a decision node, all pins together otherwise, plus `['failed']` when the failure is handled. Exclusivity, `merge` coverage, and guards all read it, so a `merge` joining a node's normal path and its failure path gets no warning. A data edge from a node into a node behind its own `failed` pin is a `starved-input` error, because a failed node has no outputs. The IR joins the two paths into one guard, so the description writes `if node.then:` and `else if node.failed:`.

## Alternatives considered

**Retry as an engine-wide setting.** One `Config` value would be simpler, but whether a second call is safe and useful depends on the node: an agent prompt may be retried, a payment should not be. The node type knows its own errors; the workflow node can override it for one use.

**Retrying every failure.** Wiring and contract errors fail the same way on every call, so retrying them only delays the report and multiplies side effects.

**A failure output port carrying the error.** It would let the failure path read the message, but a failed node would then have outputs, contradicting "a completed node produces every declared output, a failed one none", which the analysis, the run record, and the canvas all rely on. Reading the error from the failure path can be added later as engine-provided context without breaking that rule.

**A try/catch container node.** It groups the guarded nodes visibly, and it needs nested graphs or regions the canvas does not have. A pin on each node composes with the existing gating and `merge` with no new structure.

**A `failed` pin on subworkflow nodes.** The node is replaced by its expansion when a run starts, so its failure would have to be redefined as "some embedded node failed unhandled", which needs the run to keep going after an unhandled failure. Inside the embedded workflow the pin works as usual.

## Consequences

A node with a retry policy can be called several times for one invocation, on top of the at-least-once calls after a restart, so the rule that nodes tolerate repeated calls matters more; the custom-nodes skill now says a node declaring `retry` must be safe to call again. A handled failure leaves a `failed` node in a completed run, so the run status alone no longer says every node succeeded; the node records do. The path behind `failed` cannot read the error. The retry budget is per call: a node recalled after a restart starts again from zero.
