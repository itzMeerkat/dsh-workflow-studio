---
description: "A local DeepSeek Harness bundle for defining, persistently storing, validating, and running DAG workflows."
kind: "package-bundle"
---

# dsh-workflow-studio

English | [中文](README.zh.md)

## Summary

`dsh-workflow-studio` adds a durable DAG definition store, an execution engine, an extensible node registry, a `WorkflowNode` base class for node authors, three model tools, and a browser graph editor to DeepSeek Harness. Each workflow definition survives Host restarts in its own storage-domain record. Each run is checkpointed to its own record and continues after a Host restart, and a node can wait for a result from outside the run, such as a person's answer, with the request and its result saved with the run.

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

The package's [`cordis.patch.yml`](cordis.patch.yml) inserts the `dsh-workflow-studio` plugin into a Harness profile. The plugin registers no nodes: node plugins supply them, such as the separate `dsh-workflow-demo-node` plugin with its agent-prompt, human-approval, and basic example nodes. New workflows start empty. The plugin requires `ctx.tools` and `ctx.storageDomain`, then provides `ctx.workflowNodeRegistry` and `ctx.dagEngine`. The base bundle supplies the JSON backend and routes domains to it.

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

A node waits for a result from outside the run with `await context.awaitSignal(requestId, request)`, whether that result comes from a person, an external job, or another system. The `request` is any JSON value and the engine never reads it: it saves the request in the node's run record and keeps the node `running`, and `listRuns()` reports each unfinished run's number of requests without a result as `pendingRequests`. `signal()` or the `signal` Remote saves the result and passes it to the waiting node; results are accepted while the run is running, paused, or interrupted, and a node called again after a restart gets a saved result at once, or waits on the existing request when none has arrived. A signal never resumes a run by itself, so a paused or interrupted run continues only when it is resumed. The `requestId` must stay the same across calls, because it is how a node finds its own request again.

A node type checks the result format with the optional `validateSignal(request, result)` executor member. The engine calls it before saving, so a malformed result is rejected at the API instead of failing the node; without it, any JSON value is accepted.

Questions for a person are one request format, not an engine concern. `askUser(context, requestId, questions)` raises a request of kind `questions` using the format of the Harness `ask_user_question` tool from `@deepseek-ai/dsh-user-questions`, where each question may offer options, allow several selections, and accept custom text. `validateQuestionsSignal` is the matching `validateSignal`, and the Runs tab renders such requests as a form. A node plugin that wants its own request format and its own UI registers a component for its `kind` in the `workflowStudio.request` slot; a kind nobody renders is shown as its raw payload.

To require approval before a step runs, put a node that waits for it, such as `human-approval` from `dsh-workflow-demo-node`, in front of that step. The engine has no approval step of its own.

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
    { "id": "left-add", "kind": "data", "source": "left", "target": "add", "targetPort": "left" },
    { "id": "right-add", "kind": "data", "source": "right", "target": "add", "targetPort": "right" },
    { "id": "add-result", "kind": "data", "source": "add", "sourcePort": "result", "target": "result" }
  ]
}
```

Third-party Cordis plugins register a `WorkflowNodeExecutor` through `ctx.workflowNodeRegistry.register(executor, sourcePlugin)`. The registry checks the executor's fields, so any object with the required members is accepted. The required source plugin name appears with every node type in the browser catalog, and the returned disposer removes that exact registration. An executor declares connection ports, whether each input is required, optional card controls backed by `config`, and which outputs render on the card. It returns `{ status: 'completed', outputs, next? }` or `{ status: 'failed', error, outputs? }`; a node cannot skip itself, and one that does not apply completes having done no work. Completing means every declared output port carries a value, so a node with nothing to report writes `null`. A node that selects its own execution pin, such as one that branches on a human decision, implements `execute` directly instead of extending `WorkflowNode`. Its context carries `connected`, the input ports that have an incoming edge, and `invocationKey`, which is `<runId>/<nodeId>`. Node authors normally extend `WorkflowNode`, which requires `type`, `label`, `description`, business `ports`, and `run()`; `run()` returns outputs or throws `NodeFailure`.

Every edge declares a `kind`. A `data` edge carries one output port's value to one input port, and its `sourcePort` and `targetPort` default to `output` and `input`. An `exec` edge carries no data and constrains execution order only: its target runs after its source completes, and its `sourcePort` and `targetPort` default to the `then` and `run` execution pins every node has. Execution edges express the ordering a data dependency cannot — two nodes that write the same external record, a check that must be logged before the work it guards, or two human questions that must not be asked at once. A node with no incoming execution edge runs whenever the run reaches it. A node with one runs only after that edge's source completes; if the source was skipped, the edge is dead and the target is skipped without being called, so a skip travels along execution edges. Data edges never carry that signal. Several execution edges may reach one node's `run` pin, and the node runs once all of them have fired, while a data input port still accepts exactly one edge. The engine rejects an execution edge naming a pin that does not exist, a duplicate execution edge between the same pins, and any cycle formed by data and execution edges together.

A node that branches declares its own execution pins through `execOutputs` and picks which fire by returning `next`; declaring pins replaces `then`, and omitting `next` fires all of them. The engine registers the two node types whose behavior is execution semantics: `branch` takes a boolean `condition` and fires one of its `true` and `false` pins, and `merge` is the only OR join — it runs when at least one incoming execution edge has fired, is skipped only when all are dead, and passes through the single input that arrived. Every other node is an AND join, so a node that must run regardless of which branch was taken sits downstream of a `merge` rather than downstream of either path.

Because a skip travels only along execution edges, a data edge into a required input whose source can be skipped would let the target run with that input missing. The engine rejects that wiring when the workflow is saved, naming the edge and the pin that makes the source conditional; the fix is an execution edge to the target, or an optional input port.

An executor with `variadicInputs` lets each workflow node declare its own `inputs`: at least `min` ports, all of one type, and with `outputType: 'same'` exactly one output of that type. The engine checks these rules when a workflow is saved.

The sidebar's **Workflow Studio** panel opens the editor. The toolbar provides a searchable workflow picker, edits the current workflow name, and opens a searchable node menu whose rows identify their source plugins. A workflow's ID is derived from its name and is also its record file name, so `Daily Report v2` is stored as `daily-report-v2.json`; renaming a workflow moves its record to the ID the new name derives, and a duplicate name is rejected. **Export** downloads the workflow open in the editor under that same derived file name. **Import** reads such a file back into the editor as an unsaved workflow, and also accepts a record file copied straight out of the storage directory; an imported workflow whose name is already taken is renamed, so importing never replaces a saved workflow. The React Flow canvas renders one handle per declared input and output, with inputs on the left and outputs on the right, plus the `run` and `then` execution pins on every card. An execution pin connects only to an execution pin, a branch node shows one output pin per pin it declares, and a `run` pin accepts every edge that reaches it as long as no two repeat the same pair. Connection previews follow the pointer while dragging. Existing edge endpoints can be moved to another compatible port or dropped on empty canvas space to delete the edge. Selecting a node opens its details and the run result below the full-width canvas. The canvas also supports node placement, typed port-to-port connections, node creation and deletion, card controls, card output previews, JSON configuration editing, saved positions, and run-status overlays. The read-only execution-order view replaces the raw JSON view with a node graph arranged by dependency depth. It applies transitive reduction to data dependencies, removing a direct edge when another directed path already represents the same execution-order relation. An execution edge is always drawn, because the author placed it deliberately, and one leaving a node that declares several pins is labelled with the pin it uses, such as `true` or `false`. A stage is dependency depth rather than an execution batch: each node starts as soon as its own predecessors have settled, so one long-running node does not hold up an unrelated branch. The Runs list reports how many nodes a run skipped, so a run that quietly took a branch is distinguishable from one that ran everything. Save and run operations use the Host's `workflowStudio` Remote; parsing and graph validation remain Host-owned.

**Run** saves the workflow, starts a run without waiting for it, and opens the **Runs** tab. The tab lists runs for the current workflow or for all workflows, split into **Active** (unfinished, or waiting for a result) and **History**. Selecting a run shows its status, start time, duration, and error; **Pause**, **Resume**, and **Cancel run** where they apply; each waiting request, rendered by the component registered for its kind; the execution-order graph of the run's workflow snapshot with node statuses; and a table of node statuses, call counts, outputs, and errors. The toolbar shows how many runs are active and how many requests are waiting for a result, and either count opens the Runs tab. The panel refreshes run statuses every two seconds, and the canvas shows node statuses from the selected run when it belongs to the open workflow.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

`WorkflowNodeRegistry` owns node-type registration. `DagEngineProvider` stores validated definitions in the `workflow_studio` domain and runs each node as soon as every one of its own predecessors has settled, rather than a topological level at a time, so a long-running node holds up only what actually depends on it. The domain uses `per-record` layout, so the JSON backend writes each ID to `<storage-root>/workflow_studio/workflows/<id>.json`. A workflow's ID is its name reduced to `[a-z0-9-]`, with a numeric suffix when another workflow already holds that base name. Renaming writes the new record before deleting the old one, so an interrupted rename leaves a duplicate rather than losing the definition. Name lookup and writes share one engine mutation queue, so concurrent same-name saves reuse one ID. A failed node stops the scheduler from starting further nodes; the workflow fails once the nodes already started have settled, and nodes never started become cancelled, so work with side effects is never abandoned half-done.

An input port is present when the upstream output object has the selected key. Any absent required input fails the node, naming the port and the node that owed it, because a node that runs asserts its required data is there. Missing optional inputs do not block execution.

`pauseRun()` stops new nodes from starting and takes effect once those already started have settled, so a paused run has nothing running. `cancelRun()` aborts the run and ends every pause and every pending `awaitSignal()` call. Executors receive the same `AbortSignal` and must cooperate for cancellation during their own asynchronous work. The `workflowStudio` Remote exposes `start`, `listRuns`, `getRun`, `pause`, `resume`, `cancel`, and `signal` by run ID.

Definitions returned by `get()`, run records returned by `getRun()`, and final results are independent snapshots. Caller mutation cannot alter saved definitions or internal run state.

| File | Role |
|---|---|
| [`src/registry.ts`](src/registry.ts) | Node executor registry |
| [`src/engine.ts`](src/engine.ts) | `ctx.dagEngine` service API and events |
| [`src/engine-provider.ts`](src/engine-provider.ts) | Definition storage, run control, signal delivery, run-record writes, and recovery |
| [`src/run-executor.ts`](src/run-executor.ts) | Ready-when-predecessors-settle scheduling, pause points, waiting requests, and node results |
| [`src/validation.ts`](src/validation.ts) | Definition validation against the registry and topological order |
| [`src/run-state.ts`](src/run-state.ts) | In-memory run state and run-record conversion |
| [`src/persistence.ts`](src/persistence.ts) | Per-record storage domains for definitions and runs |
| [`src/node.ts`](src/node.ts) | `WorkflowNode` base class and `NodeFailure` |
| [`src/flow-nodes.ts`](src/flow-nodes.ts) | The engine's `branch` and `merge` nodes and the OR-join check |
| [`src/shared/json.ts`](src/shared/json.ts) | JSON checks for node outputs, notepad values, and signal payloads |
| [`src/shared/questions.ts`](src/shared/questions.ts) | The `questions` request format: `askUser`, answer checks, and approval helpers |
| [`src/tools.ts`](src/tools.ts) | Model tool registration |
| [`src/controller.ts`](src/controller.ts) | Host Remote for browser snapshots, saves, and run control |
| [`src/shared/types.ts`](src/shared/types.ts) | Types shared by the Host and the browser |
| [`src/shared/workflow-schema.ts`](src/shared/workflow-schema.ts) | JSON schemas for definitions, run records, run summaries, and the editor snapshot |
| [`src/shared/graph.ts`](src/shared/graph.ts) | Topological levels, the inbound-edge index, execution-pin rules, and port rules |
| [`src/client/index.tsx`](src/client/index.tsx) | `main` panel and sidebar registration, and Remote mounting |
| [`src/client/locale.ts`](src/client/locale.ts) | zh and en copy for the `workflowStudio` locale namespace |
| [`src/client/remote.ts`](src/client/remote.ts) | Remote method descriptors and the `callRemote` error helper |
| [`src/client/WorkflowStudioPanel.tsx`](src/client/WorkflowStudioPanel.tsx) | Workflow selection, save, run, and the canvas/execution/runs views |
| [`src/client/Menus.tsx`](src/client/Menus.tsx) | Workflow picker and node library menus |
| [`src/client/use-runs.ts`](src/client/use-runs.ts) | Run list polling, run selection, run controls, and signal delivery |
| [`src/client/ExecutionOrderView.tsx`](src/client/ExecutionOrderView.tsx) | Read-only execution dependency graph and run status |
| [`src/client/WorkflowGraphEditor.tsx`](src/client/WorkflowGraphEditor.tsx) | React Flow canvas state, node edits, and connections |
| [`src/client/graph-model.ts`](src/client/graph-model.ts) | Conversion between definitions and canvas nodes and edges, and connection rules |
| [`src/client/NodeCard.tsx`](src/client/NodeCard.tsx) | Canvas node card: ports, inline controls, and run outputs |
| [`src/client/NodeInspector.tsx`](src/client/NodeInspector.tsx) | Details panel for the selected node and the run result |
| [`src/client/model.ts`](src/client/model.ts) | Snapshot parsing, node placement, and the execution plan |
| [`src/client/RunsView.tsx`](src/client/RunsView.tsx) | Runs tab: run list, controls, question forms, and node states |
| [`src/client/runs-model.ts`](src/client/runs-model.ts) | Run record parsing, grouping, waiting requests, and answer building |
| [`src/client/slot-contract.ts`](src/client/slot-contract.ts) | The `workflowStudio.request` slot a node plugin fills with its own request UI |
| [`src/client/QuestionsRequestForm.tsx`](src/client/QuestionsRequestForm.tsx) | Built-in renderer for `questions` requests |

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
- Waiting requests are answered in the Runs tab, through the `signal` Remote, or with `signal()`; they are not forwarded to Harness chat Sessions, and the built-in question form renders every question as a generic option list, including `plan-review` questions.
- Cancellation during executor work depends on the executor observing `context.signal`.
- A record key accepts only `[A-Za-z0-9_-]`, so a name written entirely in non-ASCII characters reduces to `workflow` and is told apart from the next such name only by a numeric suffix.
- The visual editor does not yet provide undo/redo, copy/paste, groups, automatic layout, or multi-node configuration editing.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

Run `pnpm test` for the focused Node test suite, `pnpm typecheck` to check source and test types, and `pnpm build` for bundling plus declaration generation. New node registrations must name their source plugins, remain owned by a Cordis effect or returned disposer, and accurately declare every port used by workflow edges.

</details>
