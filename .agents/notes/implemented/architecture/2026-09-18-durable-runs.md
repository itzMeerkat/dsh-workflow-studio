# Agent Note: Durable runs and at-least-once recovery

Status: implemented

## Problem

A workflow run can last hours: an agent node works for minutes, a human approval waits for days. The Host restarts in between, for an update or a crash. A run that lives only in memory loses every completed node and every answered question when that happens, and a node with side effects, such as sending an email or filing an expense, cannot simply start over from the beginning.

## Decision

A run is a persisted record, and the engine treats that record, not memory, as the truth about the run.

**A node finishes only when its record is written.** `RunExecutor` writes the run record when a node starts and again when it ends, and starts no successor of a node until that node's end is written. The record holds the definition snapshot taken at start, each node's status, inputs, outputs, fired pins, attempt count, notepad, and waiting requests. Records live in the `workflow_studio_runs` domain, one file per run, apart from the definitions in `workflow_studio`; `retainRuns` bounds how many finished runs stay.

**Recovery is at least once.** When the Host starts, every run whose record is not terminal is loaded again. A node that was `running` goes back to `pending` and is called again, so a node can run twice and must tolerate it. Two tools make that tolerable:

- `invocationKey` is `<runId>/<nodeId>`, the same on every attempt, so a node can pass it to an external system as an idempotency key.
- `notepad` is a JSON value the node saves into its own record, so an attempt can leave a note for the next one, such as the ID of the agent Session it opened.

**A node can refuse to be called again.** `recovery: 'hold'`, on the node type or on one workflow node, stops automatic recovery: the run becomes `interrupted` and waits for a person to resume it. `autoRestart: false` holds every interrupted run the same way. A run whose definition no longer resolves against the registry is held too, rather than failed, because the missing node plugin may come back.

**Waiting is durable.** `awaitSignal(requestId, request)` writes the request into the node's record before it waits, and `signal()` writes the result before it wakes the node. A result delivered while the Host was down, or while the run was held, stays in the record, and the recalled node receives it at once instead of asking again.

**Stopping is not ending.** When the engine shuts down it aborts its runs but writes no final status, so their records stay as they were and recovery picks them up. A run whose final write fails stays in memory with its final status, so a query still reads it.

## Alternatives considered

**Exactly-once execution.** It would need a transaction spanning the node's external effect and the record write, which the engine cannot have for an email or an agent turn. Promising it would only hide the duplicate call. At least once, with a stable `invocationKey` and a `notepad`, lets each node decide how to make a second call safe.

**Restarting a run from the beginning.** Simpler for the engine, and wrong for every node with a side effect: completed approvals would be asked again and completed actions repeated. Per-node records cost one write per node start and end, which is small next to what a node does.

**Failing interrupted runs.** It is the honest default for a short batch job, but a workflow that waited three days for an approval should not be lost to a restart. `autoRestart` and `hold` let a deployment or a node choose caution instead.

**Keeping waiting requests outside the run record.** A separate queue would need its own retention and its own recovery. In the record they share the run's lifetime, its pruning, and its one write path.

## Consequences

Every node must tolerate being called twice for one invocation; the custom-nodes skill says so, and nodes with external effects use `invocationKey` or `notepad`. Each node start and end is a write, so a workflow of many tiny nodes pays for durability it may not need. A run's definition is a snapshot, so editing a workflow never changes a run already started, and a run keeps working after its workflow is deleted. The record format is durable data: changing it needs a domain version bump or a reader that accepts the older records.
