# AGENTS.md

Read [README.md](README.md) before changing this plugin. The repository root [AGENTS.md](../AGENTS.md) and documentation rules in [docs/AGENTS.md](../docs/AGENTS.md) also apply.

## Current scope

- `src/registry.ts` owns `ctx.workflowNodeRegistry`.
- `src/engine.ts` defines `ctx.dagEngine` and DAG lifecycle events.
- `src/shared/` holds the modules the Host and the browser both load: types, JSON schemas, graph and port rules, and error messages. Keep them free of Host-only imports.
- `src/persistence.ts` owns the `workflow_studio` and `workflow_studio_runs` per-record domains; `src/json.ts` owns JSON checks for persisted node values.
- `src/validation.ts` owns definition validation against the registry; `src/run-state.ts` owns in-memory run state and its conversion to run records.
- `src/engine-provider.ts` owns durable definitions, scheduling, recovery, human input, pause, resume, and cancellation.
- `src/node.ts` owns the `WorkflowNode` base class, `NodeFailure`, and the condition gate.
- The plugin registers no nodes. Node implementations live in node plugins such as `dsh-workflow-demo-node`; `tests/fixture-nodes.ts` holds test-only nodes for engine tests.
- `src/tools.ts` owns `create_workflow`, `run_workflow`, and `get_workflow_run`.
- `src/client/index.tsx` owns the `main` panel, workflow picker, and `sidebar.panellist` entry.
- `src/client/WorkflowGraphEditor.tsx` owns editable data-flow rendering.
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
- Reject empty or duplicate IDs, unknown node types, unknown ports, duplicate target-port edges, missing required input edges, and cycles.
- Store and return independent snapshots; callers must not mutate engine state through retained references.
- Execute topological levels in order and nodes within one level concurrently.
- A failed node fails the workflow after the current level settles; pending downstream nodes become cancelled.
- The engine calls an executor's optional `preflight()` before input checks and human confirmation; a returned result settles the node. The engine assigns no meaning to `condition`; `WorkflowNode.preflight()` owns that gate.
- Pass `connected` (input ports with an incoming edge) and `invocationKey` (`<runId>/<nodeId>`) in every execution context.
- Missing required data from a skipped dependency propagates `skipped`; other partial required inputs fail.
- Executors return the discriminated `NodeExecutionResult` union and observe `context.signal` during asynchronous work.
- `pause()` waiters must be released by both `resume()` and `cancel()`; `cancel()` and shutdown also reject pending `askHuman()` calls.
- Save a human-input request before announcing it and save an answer before delivering it. An answered request returns its saved answer when a re-called node asks with the same ID; an unanswered one is reused, never duplicated.
- `requiresHumanInput` asks the reserved `dsh.confirm` request before the executor runs; only `批准` without custom text approves, and anything else fails the node.
- Write a node's running state before calling it and its final state before the next level starts; a node is finished only once its final state is durable.
- Engine shutdown writes no final run state, so restart recovery sees the last checkpoint. Recovery starts only after the plugin loader finishes.
- Never call a completed or skipped node again during recovery. A recovered run restarts only when `autoRestart` is on, every interrupted node's effective `recovery` is `rerun`, and every node type resolves; otherwise it becomes `interrupted`.
- Persist only JSON values: drop `undefined` output ports and fail nodes whose outputs contain other non-JSON values.

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
