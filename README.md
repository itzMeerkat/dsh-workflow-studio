---
description: "A local DeepSeek Harness bundle for defining, persistently storing, validating, and running DAG workflows."
kind: "package-bundle"
---

# dsh-workflow-studio

English | [中文](README.zh.md)

## Summary

`dsh-workflow-studio` adds a durable DAG definition store, an execution engine, an extensible node registry, a `WorkflowNode` base class for node authors, a separately mounted demo node plugin, two model tools, and a browser graph editor to DeepSeek Harness. Each workflow definition survives Host restarts in its own storage-domain record. Runs, retries, and approval integration remain process-local or unimplemented.

## Table of Contents

- [Install](#install)
- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="install"></a>
## Install

Workflow Studio adds a Web panel, so install it into a profile that includes the `@deepseek-ai/dsh-web-app` bundle. `dsh plugin` creates a missing profile with only `@deepseek-ai/dsh-base`, which has no Web UI; create the profile from the `web` template first. `--dump-config` creates the profile without booting it:

```sh
dsh --profile <name> --from-default-profile web --dump-config
```

### Install from GitHub

A git install fetches source only. The package's `prepare` script runs `pnpm build` to produce `lib/`, and pnpm refuses to run it until the profile allows it.

1. Run the install and pin a commit:

   ```sh
   dsh plugin --profile <name> add github:itzMeerkat/dsh-workflow-studio#<commit>
   ```

2. The first attempt fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. Copy the exact `allowBuilds` key from that error into `$DSH_HOME/profiles/<name>/pnpm-workspace.yaml` (`$DSH_HOME` defaults to `~/.dsh`). The key names the package, repository URL, and commit; a bare package name is not accepted:

   ```yaml
   allowBuilds:
     "dsh-workflow-studio@git+https://github.com/itzMeerkat/dsh-workflow-studio.git#<commit>": true
   ```

3. Rerun the command from step 1. Then confirm that the composed configuration contains a `# == dsh-workflow-studio` layer, and boot the profile:

   ```sh
   dsh --profile <name> --dump-config
   dsh --profile <name>
   ```

The allowance lets this package's build run on your machine with your user permissions, outside the agent sandbox. Allow only a commit whose source you trust.

To update, repeat steps 1–3 with the new commit; each commit needs its own `allowBuilds` key. To uninstall, run `dsh plugin --profile <name> remove dsh-workflow-studio`, which removes the dependency and its bundle layer.

### Install from a local checkout

`pnpm install` in the checkout runs `prepare`, which builds `lib/`. Then link the checkout into the profile; a linked checkout needs no `allowBuilds` entry:

```sh
pnpm install
dsh plugin --profile <name> add /path/to/dsh-workflow-studio
```

The profile loads the checkout's `lib/` directly. After editing the source, run `pnpm build` and restart the profile.

-----

<a id="use-this-package"></a>
## Use this package

The package's [`cordis.patch.yml`](cordis.patch.yml) inserts the `dsh-workflow-studio` plugin and the `dsh-workflow-studio/demo` plugin into a Harness profile. The core plugin registers no nodes; the demo plugin registers the example `input`, `arithmetic`, `if`, `coalesce`, and `output` nodes, and disabling its `workflow-studio-demo` row leaves only nodes from other plugins. The core plugin requires `ctx.tools` and `ctx.storageDomain`, then provides `ctx.workflowNodeRegistry` and `ctx.dagEngine`. The base bundle supplies the JSON backend and routes domains to it.

The model receives two tools:

| Tool | Purpose |
|---|---|
| `create_workflow` | Validate and durably save one named workflow definition |
| `run_workflow` | Start a saved workflow by exact name |

`create_workflow` requires explicit node and edge IDs. Every node type must already be registered, each referenced port must exist, and every required input port must have exactly one incoming edge. Optional inputs may remain disconnected. Connected ports must have equal types unless either side uses `any`. Invalid definitions fail before they enter the engine.

```json
{
  "name": "sum",
  "nodes": [
    { "id": "left", "type": "input", "config": { "defaultValue": 10 } },
    { "id": "right", "type": "input", "config": { "defaultValue": 20 } },
    { "id": "add", "type": "arithmetic", "config": { "operator": "add" } },
    { "id": "result", "type": "output", "config": {} }
  ],
  "edges": [
    { "id": "left-add", "source": "left", "target": "add", "targetPort": "left" },
    { "id": "right-add", "source": "right", "target": "add", "targetPort": "right" },
    { "id": "add-result", "source": "add", "sourcePort": "result", "target": "result" }
  ]
}
```

Third-party Cordis plugins register a `WorkflowNodeExecutor` through `ctx.workflowNodeRegistry.register(executor, sourcePlugin)`. The registry checks the executor's fields, so any object with the required members is accepted. The required source plugin name appears with every node type in the browser catalog, and the returned disposer removes that exact registration. An executor declares connection ports, whether each input is required, optional card controls backed by `config`, and which outputs render on the card. It returns `{ status: 'completed', outputs }`, `{ status: 'failed', error, outputs? }`, or `{ status: 'skipped' }`. Its context carries `connected`, the input ports that have an incoming edge, and `invocationKey`, which is `<runId>/<nodeId>`. Node authors normally extend `WorkflowNode`, which requires `type`, `label`, `description`, business `ports`, and `run()`; `run()` returns outputs or throws `NodeFailure`.

`WorkflowNode` appends an optional boolean `condition` input unless the subclass sets `conditional` to `false`. A disconnected condition does not affect execution; a connected condition must produce `true`, otherwise the node is skipped without calling `run()`, and a non-boolean value fails it. The gate runs in the executor's optional `preflight()`, which the engine calls before its input checks and any human confirmation. A plain executor has no condition input unless it declares one. The demo `if` node evaluates a user-configured JEXL expression against required `left` and `right` inputs of type `any`, then produces mutually exclusive `true` and `false` condition signals. Expressions support JavaScript-style comparison, arithmetic, property access, `&&`, `||`, `!`, and ternary operators, including `===` and `!==`. The evaluator exposes no Host globals or functions, rejects statements and assignment, and requires a boolean result.

The demo `coalesce` node merges mutually exclusive data branches. A coalesce instance declares at least two optional inputs of one port type and one output of that same type. At runtime, exactly one connected input may contain a non-`null` value; zero or multiple non-`null` values fail the node. Instance `inputs` can add more candidates while preserving these type rules.

The sidebar's **Workflow Studio** panel opens the editor. The toolbar provides a searchable workflow picker, edits the current workflow name, and opens a searchable node menu whose rows identify their source plugins. Renaming and saving an existing workflow preserves its ID; a duplicate name is rejected. The React Flow canvas renders one handle per declared input and output, with inputs on the left and outputs on the right. Connection previews follow the pointer while dragging. Existing edge endpoints can be moved to another compatible port or dropped on empty canvas space to delete the edge. Selecting a node opens its details and the run result below the full-width canvas. The canvas also supports node placement, typed port-to-port connections, node creation and deletion, card controls, card output previews, JSON configuration editing, saved positions, and run-status overlays. The read-only execution-order view replaces the raw JSON view with a node graph arranged by the scheduler's topological stages. It applies transitive reduction to data and condition dependencies, removing a direct edge when another directed path already represents the same execution-order relation. A retained condition edge leaves its branch node through a labeled output such as `true` or `false`; nodes in one stage run concurrently. Save and run operations use the Host's `workflowStudio` Remote; parsing and graph validation remain Host-owned.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

`WorkflowNodeRegistry` owns node-type registration. `DagEngineProvider` stores validated definitions in the `workflow_studio` domain, computes Kahn topological levels, and executes each level in parallel. The domain uses `per-record` layout, so the JSON backend writes each ID to `<storage-root>/workflow_studio/workflows/<id>.json`. Name lookup and writes share one engine mutation queue, so concurrent same-name saves reuse one ID. A failed node makes the workflow fail after its current level settles, and pending downstream nodes become cancelled.

An input port is present when the upstream output object owns the selected key, even when its value is `undefined`. A `preflight()` result settles the node before the engine checks inputs. A missing required input from a skipped dependency also propagates `skipped`; other partial required inputs fail. Missing optional inputs do not block execution.

`pause()` takes effect between levels. A node marked `requiresHumanInput` pauses before its executor runs. One `resume()` call releases every node waiting in the same parallel level. `cancel()` aborts the run and releases all pause waiters. Executors receive the same `AbortSignal` and must cooperate for cancellation during their own asynchronous work.

Definitions returned by `get()`, run records returned by `getRun()`, and final results are independent snapshots. Caller mutation cannot alter saved definitions or internal run state.

| File | Role |
|---|---|
| [`src/registry.ts`](src/registry.ts) | Node executor registry |
| [`src/engine.ts`](src/engine.ts) | `ctx.dagEngine` service API and events |
| [`src/workflow-schema.ts`](src/workflow-schema.ts) | Shared Host and browser workflow JSON schema |
| [`src/persistence.ts`](src/persistence.ts) | Per-record storage-domain declaration |
| [`src/engine-provider.ts`](src/engine-provider.ts) | Validation, scheduling, pause, resume, and cancellation |
| [`src/node.ts`](src/node.ts) | `WorkflowNode` base class, `NodeFailure`, and the condition gate |
| [`src/demo/`](src/demo/) | Demo `input`, `arithmetic`, `if`, `coalesce`, and `output` nodes and their plugin entry |
| [`src/tools.ts`](src/tools.ts) | Model tool registration and JSON input parsing |
| [`src/controller.ts`](src/controller.ts) | Host Remote for browser snapshots, saves, and runs |
| [`src/client/index.tsx`](src/client/index.tsx) | Localized workflow picker, canvas/execution views, save, and run actions |
| [`src/client/ExecutionOrderView.tsx`](src/client/ExecutionOrderView.tsx) | Read-only execution dependency graph and run status |
| [`src/client/WorkflowGraphEditor.tsx`](src/client/WorkflowGraphEditor.tsx) | React Flow canvas, custom nodes, connections, bottom details panel, and run state |
| [`src/client/model.ts`](src/client/model.ts) | Browser-side JSON parsing and editor DTOs |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`AGENTS.md`](AGENTS.md) describes the current extension and maintenance rules.
- [`dsh-workflow-studio-operations`](.agents/skills/dsh-workflow-studio-operations/SKILL.md) guides workflow creation, modification, execution, and diagnosis.
- [`dsh-workflow-studio-custom-nodes`](.agents/skills/dsh-workflow-studio-custom-nodes/SKILL.md) guides custom node implementation and registration.
- [`docs/architecture.md`](../docs/architecture.md) describes Harness plugin composition and application launch.
- [`docs/subsystems/storage.md`](../docs/subsystems/storage.md) describes durable domains and backend routing.
- [`docs/cookbook/adding-a-tool.md`](../docs/cookbook/adding-a-tool.md) describes model tool registration and presentation.

-----

<a id="model-experience"></a>
## Model Experience

### Tool surface

The model sees the `create_workflow` and `run_workflow` schemas and their rendered results. This package adds no system-prompt text and no runtime Skill.

### Token and cache effect

The two tool schemas increase every request that exposes the global tool set. Saved definitions remain Host-side durable data and run state remains Host memory; neither enters model context unless a tool result reports it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Definitions persist across Host restarts, but the JSON backend provides no cross-process write locking.
- Runs are not written to Session events and cannot resume after process failure.
- There is no retry scheduler or at-least-once execution guarantee.
- `start()` accepts no workflow-level input values.
- `PortDefinition.type` controls edge compatibility, but the engine does not perform general runtime value-type validation.
- HITL is controlled only through the `DagRun` handle and is not connected to the Harness approval service or browser UI; running a HITL workflow from the editor therefore waits for an external resume.
- Cancellation during executor work depends on the executor observing `context.signal`.
- The visual editor does not yet provide undo/redo, copy/paste, groups, automatic layout, or multi-node configuration editing.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

Run `pnpm test` for the focused Node test suite and `pnpm build` for bundling plus declaration generation. New node registrations must name their source plugins, remain owned by a Cordis effect or returned disposer, and accurately declare every port used by workflow edges.

</details>
