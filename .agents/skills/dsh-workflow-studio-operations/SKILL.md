---
name: "dsh-workflow-studio-operations"
description: "Operate and modify durable DAG workflows through the browser, model tools, or DagEngine API. Invoke when creating, editing, running, inspecting, or debugging a Workflow Studio workflow."
---

# Workflow Studio Operations

Use this skill to create, modify, run, and diagnose workflow definitions. It is an operating procedure, not the runtime contract. Read the package [README](../../../README.md) and the current [engine API](../../../src/engine.ts) when a task depends on exact behavior.

## Choose an interface

| Task | Interface |
|---|---|
| Visually create, connect, configure, save, or run a workflow | Workflow Studio browser panel |
| Let a model create, start, or check a workflow | `create_workflow`, `run_workflow`, and `get_workflow_run` tools |
| Read definitions, preserve workflow IDs, await results, list runs, pause, resume, cancel, or answer human input | `ctx.dagEngine` |

Do not edit files under the storage root directly. The engine owns schema parsing, graph validation, name uniqueness, snapshots, and durable writes.

## Operate in the browser

1. Open **Workflow Studio** from the application sidebar.
2. Use the folder button beside the workflow name to search, select, or create a workflow.
3. Edit the name, add nodes from **Add node**, and connect explicit output and input handles.
4. Select a node to edit its label and configuration. Use card controls when the node provides them.
5. Use **Execution order** to inspect scheduler stages and condition branches. This view is read-only.
6. Save before treating the definition as durable. **Run** saves the current definition, starts a run, and opens the **Runs** tab, where you can follow its node states, pause, resume, or cancel it, and answer its questions.
7. Inspect node status and outputs in the bottom details area.

Preserve node IDs and edge IDs for unchanged graph elements. Stable IDs keep saved positions, run records, and visual references understandable.

## Define a workflow

A complete definition contains a name, nodes, and edges. Node and edge IDs must be non-empty and unique.

```json
{
  "name": "emit-value",
  "nodes": [
    {
      "id": "source",
      "type": "input",
      "config": { "defaultValue": 5 }
    },
    {
      "id": "result",
      "type": "output",
      "config": {}
    }
  ],
  "edges": [
    {
      "id": "source-result",
      "source": "source",
      "sourcePort": "output",
      "target": "result",
      "targetPort": "input"
    }
  ]
}
```

Use registered node types only. Match port names exactly. Connected types must match unless either port uses `any`. Every required input needs exactly one incoming edge; optional inputs may remain disconnected. The graph must be acyclic.

## Use model tools

Use `create_workflow` with a complete definition. A workflow with the same name replaces the prior definition and retains its workflow ID.

Use `run_workflow` with the exact saved name. The tool returns the run ID and does not wait for the final result; use `get_workflow_run` with that ID to read the run and node statuses.

Do not invent node types, ports, IDs, or missing required values when preparing tool arguments. Inspect the registered catalog or existing definition first.

## Use the engine API

The API returns detached definitions and results. Await every durable mutation.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-workflow-studio'

export async function renameWorkflow(ctx: Context, currentName: string, nextName: string) {
  const summary = ctx.dagEngine.findByName(currentName)
  if (summary === undefined) throw new Error(`Workflow "${currentName}" was not found`)

  const definition = ctx.dagEngine.get(summary.id)
  if (definition === undefined) throw new Error(`Workflow "${summary.id}" disappeared`)

  return ctx.dagEngine.update(summary.id, { ...definition, name: nextName })
}
```

Start and observe a run through its owning handle:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-workflow-studio'

export async function runWorkflow(ctx: Context, name: string) {
  const summary = ctx.dagEngine.findByName(name)
  if (summary === undefined) throw new Error(`Workflow "${name}" was not found`)

  const run = ctx.dagEngine.start(summary.id)
  return run.result
}
```

`run.result` settles with a `WorkflowResult` and does not reject. A run restored after a Host restart has no handle; control it by ID with `pauseRun()`, `resumeRun()`, `cancelRun()`, and `answerInput()`, and read it with `getRun()` or `listRuns()`.

## Modify safely

1. Read the current definition before changing it.
2. Change the smallest set of nodes, edges, ports, configuration fields, or positions needed for the task.
3. Keep IDs for unchanged elements.
4. Submit the complete replacement definition through `save()` or `update()`.
5. Await the returned promise.
6. Read the saved definition again when the caller needs confirmation.
7. Run the workflow and inspect failed, skipped, and cancelled node records separately.

`save()` uses the workflow name as the replacement key. `update()` preserves the supplied workflow ID and rejects a name already owned by another workflow.

## Understand execution

- The scheduler executes topological stages in order and nodes within one stage concurrently.
- Nodes built on `WorkflowNode` have an optional boolean `condition` input unless they opt out. A disconnected condition has no effect. A connected `false` or missing value skips the node; a non-boolean value fails it.
- Missing required data from a skipped dependency propagates `skipped`. Other partial required inputs fail the node.
- A failed node fails the workflow after the current stage settles. Pending downstream nodes become cancelled.
- Runs are saved with a definition snapshot. After a Host restart, unfinished runs continue and nodes that were running are called again; runs that need a person to decide become `interrupted`.
- Cancellation during executor work depends on that executor observing `context.signal`.

## Diagnose failures

Check these causes in order:

1. Unknown node type or port: inspect `ctx.workflowNodeRegistry.listTypes()`.
2. Missing or duplicate edge: compare every required input with incoming edges.
3. Type mismatch: compare source and target `PortDefinition.type`.
4. Cycle: inspect **Execution order** and remove the dependency cycle.
5. Skipped node: inspect its connected condition and skipped upstream dependencies.
6. Failed node: inspect the node record's `inputs`, `outputs`, and `error`.
7. Run waiting on a person (a `requiresHumanInput` node or any node calling `askHuman`, such as `human-approval` from `dsh-workflow-demo-node`): answer it in the panel's **Runs** tab, or find the unanswered entry in the node record's `interactions` and call `answerInput()`.
8. Interrupted run: read its `error` for the reason, fix it (for example, load the missing node plugin), then call `resumeRun()` or `cancelRun()`.

When package code changes, run `pnpm test` and `pnpm build` from `dsh-workflow-studio`.
