# AGENTS.md

Read [README.md](README.md) before changing this plugin. The repository root [AGENTS.md](../AGENTS.md) and documentation rules in [docs/AGENTS.md](../docs/AGENTS.md) also apply.

## Current scope

- `src/registry.ts` owns `ctx.workflowNodeRegistry`.
- `src/engine.ts` defines `ctx.dagEngine` and DAG lifecycle events.
- `src/shared/` holds the modules the Host and the browser both load: types, JSON schemas, graph and port rules, execution-pin names and edge-kind predicates, and error messages. Keep them free of Host-only imports.
- `src/persistence.ts` owns the `workflow_studio` and `workflow_studio_runs` per-record domains; `src/shared/json.ts` owns JSON checks for persisted node values; `src/shared/questions.ts` owns the `questions` request format.
- `src/validation.ts` owns definition validation against the registry; `src/run-state.ts` owns in-memory run state and its conversion to run records.
- `src/engine-provider.ts` owns durable definitions, run control, answers, run-record writes, and recovery.
- `src/run-executor.ts` owns one run's scheduling loop: the ready queue, pause points, execution-edge gating, input gating, confirmation, human input requests, and node results.
- `src/node.ts` owns the `WorkflowNode` base class and `NodeFailure`.
- `src/flow-nodes.ts` owns the engine's `branch` and `merge` nodes and the OR-join identity check. The engine registers node types whose behavior *is* execution semantics, and nothing else; every other node lives in a node plugin such as `dsh-workflow-demo-node`. `tests/fixture-nodes.ts` holds test-only nodes for engine tests.
- `src/tools.ts` owns `create_workflow`, `run_workflow`, and `get_workflow_run`.
- `src/client/index.tsx` registers the `main` panel and `sidebar.panellist` entry; `src/client/locale.ts` owns all panel copy.
- `src/client/WorkflowStudioPanel.tsx` owns workflow selection, save, and run; `src/client/use-runs.ts` owns run polling and run controls; `src/client/Menus.tsx` owns the picker menus.
- `src/client/WorkflowGraphEditor.tsx` owns editable data-flow rendering; `src/client/graph-model.ts` owns canvas conversion and connection rules; `NodeCard.tsx` and `NodeInspector.tsx` render one node and the selected node's settings.
- `src/client/ExecutionOrderView.tsx` owns the read-only execution dependency graph.
- `src/client/RunsView.tsx` owns the Runs tab; `src/client/runs-model.ts` owns run parsing, grouping, and answer building.
- `.agents/skills/` owns reusable workflow-operation and custom-node development procedures.

Do not describe Session persistence, retries, Skills, or approval-service integration as implemented until the corresponding source and tests exist.

## Service and registration rules

- Declare required Cordis services with `inject` or `static inject`; use the injected `ctx.service` property directly.
- Every registry or tool contribution must return a disposer that is collected by the owning Cordis fiber.
- Registration setup that can partially succeed must validate first or roll back before rethrowing.
- A disposer may remove only the exact object it registered.
- Keep the engine behind the `DagEngine` service API and third-party nodes behind `WorkflowNodeRegistry`.

## Workflow rules

- Validate definitions completely in `save()` before storing them.
- Serialize name lookup and writes so concurrent same-name saves reuse one workflow ID.
- Reject empty or duplicate IDs, unknown node types, unknown ports, duplicate target-port edges, missing required input edges, unknown execution pins, duplicate execution edges, and cycles formed by data and execution edges together.
- Store and return independent snapshots; callers must not mutate engine state through retained references.
- Start each node as soon as every one of its own predecessors has settled, not when a topological level completes; both edge kinds count as predecessors. A node waiting for an external result stays `running`, so its successors keep waiting.
- An execution edge constrains order only. Read inbound edges through the per-run index rather than rescanning `definition.edges`: an execution edge supplies no input, occupies no input port, and never appears in `connected`.
- `execPinFault` owns whether an execution edge's pins are valid. Host validation and the canvas's connection rules both call it; a second copy of that rule drifts, which is how branch pins once became unconnectable in the editor while `save()` accepted them.
- A node whose incoming execution edge has a source that did not complete is skipped without being called, so a skip travels along execution edges. A data edge never carries that signal.
- A failed node stops the scheduler from starting further nodes; the run fails once the nodes already started have settled, and nodes never started become cancelled. Started work is never abandoned, because a node may have side effects.
- `pauseRun()` takes effect once the nodes already started have settled, so a paused run has nothing running.
- Cancelling, failing, and pausing stop new starts but never abandon a started node: the run settles its outcome after the in-flight nodes finish, so a finished run records no node as `running`.
- A node has three outcomes. `completed` means every declared output port carries a value, whether the node computed it or did nothing. `skipped` means a dead incoming execution edge, and nothing else. `failed` covers everything else, including an absent required input.
- Nodes cannot skip themselves; a node that does not apply completes having done no work. Enforce output completeness in the engine: the registry accepts executors by field, so a base-class check would not bind third-party node types.
- Branching is public through `execOutputs` and `next`; joining is not. Every node is an AND join except the engine's `merge`, identified by instance so no third-party node can claim the semantics.
- A node that selects its own execution pin implements `WorkflowNodeExecutor` directly; `WorkflowNode` is for nodes whose `run()` only computes outputs. Never leave an unreachable `run()` stub behind.
- A declared execution pin must be able to fire. Configuration that decides which pin fires belongs in the graph instead, or an author can wire a path that silently never runs.
- Pass `connected` (input ports with an incoming edge) and `invocationKey` (`<runId>/<nodeId>`) in every execution context.
- Any absent required input fails the node; a skip never travels along a data edge. `save()` rejects a data edge into a required input whose source can be skipped while the target cannot, so that failure is normally unreachable at run time.
- Executors return the discriminated `NodeExecutionResult` union and observe `context.signal` during asynchronous work.
- `pause()` waiters must be released by both `resume()` and `cancel()`; `cancel()` and shutdown also reject pending `awaitSignal()` calls.
- Save a waiting request before announcing it and save a result before delivering it. A request with a result returns it when a re-called node waits with the same ID; one without a result is reused, never duplicated.
- The engine assigns no meaning to a request payload or its result; a node type checks its own result format through `validateSignal`, and the browser dispatches on the payload's `kind`.
- A node waiting for a result stays `running`, so it obeys its own `recovery` policy after a restart like any other running node.
- Write a node's running state before calling it and its final state before any successor starts; a node is finished only once its final state is durable.
- Engine shutdown writes no final run state, so restart recovery sees the last checkpoint. Recovery starts only after the plugin loader finishes.
- Never call a completed or skipped node again during recovery. A recovered run restarts only when `autoRestart` is on, every interrupted node's effective `recovery` is `rerun`, and every node type resolves; otherwise it becomes `interrupted`.
- Persist only JSON values: fail nodes whose outputs contain non-JSON values, including an `undefined` port, which is never dropped.
- Record the fired execution pins on every completed node; restart recovery gates downstream nodes from that record without re-calling their predecessor.

## Tool and client rules

- Treat tool arguments as untrusted JSON. Parse required fields explicitly; never invent IDs, node types, or endpoints with defaults.
- Keep visible browser text in the typed `workflowStudio` locale dictionary.
- Use the shared UI primitive icons and the official `main` and `sidebar.panellist` slots.

## Verification

Run from this directory:

```sh
pnpm test
pnpm build
```
