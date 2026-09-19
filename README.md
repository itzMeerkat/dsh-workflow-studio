---
description: "A local DeepSeek Harness bundle for defining, persistently storing, validating, and running DAG workflows."
kind: "package-bundle"
---

# dsh-workflow-studio

English | [中文](README.zh.md)

## Summary

`dsh-workflow-studio` adds a durable DAG definition store, an execution engine, an extensible node registry, a `WorkflowNode` base class for node authors, a separately mounted demo node plugin, two model tools, and a browser graph editor to DeepSeek Harness. Each workflow definition survives Host restarts in its own storage-domain record. Each run is checkpointed to its own record and continues after a Host restart, and nodes can ask a person questions whose answers are saved with the run.

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

The model receives three tools:

| Tool | Purpose |
|---|---|
| `create_workflow` | Validate and durably save one named workflow definition |
| `run_workflow` | Start a saved workflow by exact name and return its run ID |
| `get_workflow_run` | Report a run's status and each node's status and call count |

`create_workflow` requires explicit node and edge IDs. Every node type must already be registered, each referenced port must exist, and every required input port must have exactly one incoming edge. Optional inputs may remain disconnected. Connected ports must have equal types unless either side uses `any`. Invalid definitions fail before they enter the engine.

Every run is saved as its own record in the `workflow_studio_runs` storage domain, together with a snapshot of the definition taken when the run started; later edits to the workflow do not affect it. The engine writes a node's running state before calling it and counts the node as finished only after its final state is written. When the Host stops, unfinished runs keep their last saved state. On the next start, after all plugins have loaded, the engine calls every node that was running again, which gives at-least-once invocation, and never calls finished nodes again. A paused run stays paused. Node outputs and notepad values must be JSON values: an output port whose value is `undefined` counts as not produced, and any other non-JSON value fails the node.

| Config field | Default | Meaning |
|---|---|---|
| `autoRestart` | `true` | Restart interrupted runs automatically on Host start |
| `retainRuns` | `100` | Number of finished runs kept; older records are deleted when a run ends |

A run restored after a restart becomes `interrupted` instead of restarting when `autoRestart` is `false`, when an interrupted node's recovery policy is `hold`, or when one of its node types is not registered. An executor declares `recovery: 'rerun' | 'hold'` (default `rerun`), and a node in a workflow definition may override it with its own `recovery`. An interrupted run continues after `resumeRun()` or the `resume` Remote, which call the unfinished nodes again.

A node that should not repeat completed work uses `context.invocationKey`, which stays the same for every call of that node in one run, and `context.notepad`. `await context.notepad.save(value)` stores a JSON value in the run record, and a node called again after a restart reads it from `context.notepad.value`.

A node asks a person with `await context.askHuman(requestId, questions)`, using the question and answer format of the Harness `ask_user_question` tool from `@deepseek-ai/dsh-user-questions`: each question may offer options, allow several selections, and accept custom text. The engine saves the request in the node's run record and marks the node `awaiting-input`; `listRuns()` reports each unfinished run's number of unanswered requests as `awaitingInput`. `answerInput()` or the `answer` Remote checks the answer against the questions, saves it, and then passes it to the waiting node. Answers are accepted while the run is running, paused, or interrupted. A node called again after a restart gets the saved answer at once for an answered `requestId`, or waits on the existing request for an unanswered one. Request IDs starting with `dsh.` are reserved for the engine.

A node marked `requiresHumanInput`, by its executor or in the workflow definition, asks the reserved `dsh.confirm` request with the options `批准` and `拒绝` before its executor runs. `批准` runs the node; `拒绝` or a custom answer fails it, and the custom text becomes part of the error. A node skipped by its condition is not asked. A node still waiting for this confirmation when the Host stops is always restarted, whatever its `recovery` policy, because its executor has not run.

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

An input port is present when the upstream output object has the selected key. A `preflight()` result settles the node before the engine checks inputs. A missing required input from a skipped dependency also propagates `skipped`; other partial required inputs fail. Missing optional inputs do not block execution.

`pause()` takes effect between levels. `cancel()` aborts the run and ends every pause and every pending `askHuman()` call. Executors receive the same `AbortSignal` and must cooperate for cancellation during their own asynchronous work. The `workflowStudio` Remote exposes `start`, `listRuns`, `getRun`, `pause`, `resume`, `cancel`, and `answer` by run ID; `run` starts a run and waits for it to settle.

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
| [`src/run-persistence.ts`](src/run-persistence.ts) | Run record schema and storage-domain declaration |
| [`src/json.ts`](src/json.ts) | JSON checks for node outputs and notepad values |
| [`src/human-input.ts`](src/human-input.ts) | Question and answer checks and the `dsh.confirm` confirmation question |
| [`src/tools.ts`](src/tools.ts) | Model tool registration and JSON input parsing |
| [`src/controller.ts`](src/controller.ts) | Host Remote for browser snapshots, saves, and run control |
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

The model sees the `create_workflow`, `run_workflow`, and `get_workflow_run` schemas and their rendered results. This package adds no system-prompt text and no runtime Skill.

### Token and cache effect

The three tool schemas increase every request that exposes the global tool set. Saved definitions and run records remain Host-side durable data; neither enters model context unless a tool result reports it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Definitions persist across Host restarts, but the JSON backend provides no cross-process write locking.
- Runs are not written to Session events, and a run started by `run_workflow` is not linked to the calling Session.
- Nodes are called again only after a Host restart; a failed node is not retried within a running Host.
- `start()` accepts no workflow-level input values.
- `PortDefinition.type` controls edge compatibility, but the engine does not perform general runtime value-type validation.
- The browser editor has no form for answering human-input requests yet; answers arrive only through the `answer` Remote or `answerInput()`. Requests are not forwarded to Harness chat Sessions.
- Cancellation during executor work depends on the executor observing `context.signal`.
- The visual editor does not yet provide undo/redo, copy/paste, groups, automatic layout, or multi-node configuration editing.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

Run `pnpm test` for the focused Node test suite and `pnpm build` for bundling plus declaration generation. New node registrations must name their source plugins, remain owned by a Cordis effect or returned disposer, and accurately declare every port used by workflow edges.

</details>
