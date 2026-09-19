# AGENTS.md

Read [README.md](README.md) before changing this plugin. The repository root [AGENTS.md](../AGENTS.md) and documentation rules in [docs/AGENTS.md](../docs/AGENTS.md) also apply.

## Current scope

- `src/registry.ts` owns `ctx.workflowNodeRegistry`.
- `src/engine.ts` defines `ctx.dagEngine` and DAG lifecycle events.
- `src/workflow-schema.ts` owns the shared workflow-definition JSON schema.
- `src/persistence.ts` owns the `workflow_studio` per-record domain.
- `src/engine-provider.ts` owns durable definitions, validation, scheduling, pause, resume, and cancellation.
- `src/basic-nodes.ts` owns the five bundled executors.
- `src/tools.ts` owns `create_workflow` and `run_workflow`.
- `src/client/index.tsx` owns the `main` panel, workflow picker, and `sidebar.panellist` entry.
- `src/client/WorkflowGraphEditor.tsx` owns editable data-flow rendering.
- `src/client/ExecutionOrderView.tsx` owns the read-only execution dependency graph.
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
- A false or absent connected `condition` value skips a normal node without calling its executor.
- Missing required data from a skipped dependency propagates `skipped`; other partial required inputs fail.
- Executors return the discriminated `NodeExecutionResult` union and observe `context.signal` during asynchronous work.
- HITL pause waiters must be released by both `resume()` and `cancel()`.

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
