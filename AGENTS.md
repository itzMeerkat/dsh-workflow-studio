# AGENTS.md

Read [README.md](README.md) before changing this plugin. The repository root [AGENTS.md](../AGENTS.md) and documentation rules in [docs/AGENTS.md](../docs/AGENTS.md) also apply.

## Current scope

- `src/registry.ts` owns `ctx.workflowNodeRegistry`.
- `src/engine.ts` defines `ctx.dagEngine` and DAG lifecycle events.
- `src/shared/` holds the modules the Host and the browser both load: types, JSON schemas, graph and port rules, execution-pin names and edge-kind predicates, record-key naming, and error messages. Keep them free of Host-only imports.
- `src/persistence.ts` owns the `workflow_studio` and `workflow_studio_runs` per-record domains; `src/shared/json.ts` owns JSON checks for persisted node values; `src/shared/questions.ts` owns the `questions` request format.
- `src/shared/analysis.ts` owns the whole-graph analysis: each node's condition guard, the diagnostics that follow from it, and output type inference. It reads a definition plus the node-type catalog and nothing else, so the Host runs it on save and the browser runs the same pass against the canvas. `src/diagnostic-message.ts` owns the Host wording of one diagnostic or render fault; the browser's wording belongs to `src/client/locale.ts`. `src/shared/ir.ts` owns the intermediate representation — execution order, the guard blocks each node sits in, and each argument's source. The IR carries no language decision: identifiers, indentation and block syntax belong to the generator.
- `src/validation.ts` owns definition validation against the registry; `src/run-state.ts` owns in-memory run state and its conversion to run records.
- `src/engine-provider.ts` owns durable definitions, run control, answers, run-record writes, and recovery.
- `src/run-executor.ts` owns one run's scheduling loop: the ready queue, pause points, execution-edge gating, input gating, confirmation, human input requests, and node results.
- `src/node.ts` owns the `WorkflowNode` base class and `NodeFailure`.
- `src/flow-nodes.ts` owns the engine's `branch` and `merge` nodes, the `workflow-input` and `workflow-output` boundary nodes, and the OR-join identity check. `src/shared/workflow-boundary.ts` owns the boundary node types, the workflow signature read from them, and a run's input values. The engine registers node types whose behavior *is* execution semantics or the workflow's own boundary, and nothing else; every other node lives in a node plugin such as `dsh-workflow-demo-node`. `tests/fixture-nodes.ts` holds test-only nodes for engine tests.
- `src/shared/source.ts` owns the one generator that writes an IR as source, for both kinds: the workflow's `Language` decides the block syntax and the workflow kind decides what a node becomes. Pseudocode is not a separate projection, it is the `PSEUDOCODE` language of every `run` workflow. `src/shared/language.ts` owns the languages and the `code` node types together, and a `code` workflow names its language in the definition. Languages are code in this package, not plugin data, because the browser parses atoms (`goAtom` in `src/shared/go.ts`) to draw their ports. A `code-atom` node stores only a file name in its workflow's `atomFolder`, which is one Go package: the Host reads the folder (`src/atom-folder.ts`, Remote `atomFiles`), `withSignatures` writes each atom node's ports from its signature (in the panel, the canvas and `create_workflow`), and the generator reads the signature again rather than trusting the stored ports. An atom file exports exactly one function (`isAtomFile` decides which files count; `types.go` holds the custom types and is never parsed), and a port's type is the exact Go type, with the four built-in port types standing for `float64`, `bool`, `string` and `any` (`GO_TYPES`, spelled back by `typeName`). The generator writes only the workflow's function, never the atoms; saving writes it into the folder as `workflow.go` after rendering succeeds (`saveWithFile`), and reading the folder skips that file. `skills/workflow-code-atoms.md` teaches a model to build these graphs; change it together with the node, port and fault rules it describes.
- `src/tools.ts` owns `create_workflow`, `describe_workflow`, `run_workflow`, and `get_workflow_run`.
- `src/client/index.tsx` registers one `main` panel and one `sidebar.panellist` entry per workflow kind; both panels render `WorkflowStudioPanel` with a different `kind`, and the kind decides the workflow list, the node library, the languages and the views. Only the `run` panel declares the `workflowStudio.request` child slot: a child slot can be declared once, and the `code` panel has no runs whose requests it would render. `src/client/locale.ts` owns all panel copy.
- `src/client/RunDialog.tsx` collects values for the declared inputs before a run starts; a workflow that declares none skips it.
- `src/client/WorkflowStudioPanel.tsx` owns workflow selection, save, and run; `src/client/use-runs.ts` owns run polling and run controls; `src/client/Menus.tsx` owns the picker menus.
- `src/client/transfer.ts` owns exporting one definition to a file and reading one back.
- `src/client/WorkflowBoundaryCard.tsx` renders and edits the workflow ports a boundary node declares; `src/client/workflow-ports.ts` owns that editing, port defaults, and whether a declared port can be referenced.
- `src/client/WorkflowGraphEditor.tsx` owns editable data-flow rendering; `src/client/graph-model.ts` owns canvas conversion and connection rules; `NodeCard.tsx` renders the one node card both graphs draw, and `NodeInspector.tsx` the selected node's ID and settings.
- `src/client/analysis-model.ts` owns running the analysis for the canvas and deciding when a graph cannot be analyzed; `src/client/DiagnosticsView.tsx` owns the checks list and the marker a card carries; `src/client/SourceView.tsx` owns the source tab and its language picker.
- `src/client/ExecutionOrderView.tsx` owns the read-only execution dependency graph; `src/client/execution-layout.ts` owns its stage bands and the card geometry inside them.
- `src/client/RunsView.tsx` owns the Runs tab; `src/client/runs-model.ts` owns run parsing, grouping, and answer building.
- `.agents/skills/` owns reusable workflow-operation and custom-node development procedures.

A workflow's inputs and outputs are the ports of its two boundary nodes, not a field on the definition. The direction follows the data flow: the `workflow-input` node's *outputs* are the workflow's inputs. Keep it that way — a workflow-level copy of the same fact is a second source of truth, and a change that gives workflow ports their own scheduling, skip, position or record path is a change to make the boundary nodes fit instead.

Do not describe Session persistence, retries, Skills, or approval-service integration as implemented until the corresponding source and tests exist.

## Service and registration rules

- Declare required Cordis services with `inject` or `static inject`; use the injected `ctx.service` property directly.
- Every registry or tool contribution must return a disposer that is collected by the owning Cordis fiber.
- Registration setup that can partially succeed must validate first or roll back before rethrowing.
- A disposer may remove only the exact object it registered.
- Keep the engine behind the `DagEngine` service API and third-party nodes behind `WorkflowNodeRegistry`.

## Workflow rules

- A rule that can be decided from one node or one edge belongs in `validation.ts`; a conclusion that needs the whole graph belongs in `analysis.ts`. Do not report the same fact from both: the analysis skips type checks that `validateDataEdge` already rejects and only reports what inference narrowed.
- The analysis refuses a definition only when its wiring is wrong under every branch outcome. Everything it cannot prove is a warning, because it does not know which pin a run will fire, and a warning that blocks a correct graph is worse than the run-time failure it replaces.
- `analysis.ts` and `ir.ts` require an acyclic definition whose every node type is in the catalog and whose every edge has both endpoints in the graph. The Host satisfies this by validating first; the browser satisfies it by not calling them, because each of those faults is already shown elsewhere. The browser cannot assume a loaded record satisfies them: a record saved before the boundary nodes still wires edges to `$inputs` and `$outputs`, which the current Host would refuse to save.
- `NodeTypeSummary.execKind` is derived by the registry from the executor's instance identity, never declared by the executor, so a third-party node cannot claim `decision` or `join` semantics. `kinds` is the opposite: a node declares which workflow kinds it belongs to, because that is a statement about where the node makes sense rather than about how the engine schedules it.
- A workflow's `kind` decides which node types it may use and whether it is executed or compiled. It is required on `DagWorkflowDefinition` and defaulted to `run` by `workflowDefinitionSchema`, so records written before kinds existed load unchanged and nothing in the code has to ask whether a kind is present.
- The IR places each node under exactly its guard and after all of its upstream nodes, and chooses among valid orders only to keep blocks few. Do not group nodes by guard first and order the groups afterwards: a node inside a branch can depend on a node that follows the branch, so one condition may need two blocks.
- `workflowStudioSnapshotSchema` must carry every `NodeTypeSummary` field the browser reads. Zod drops undeclared keys, so a field missing there is silently absent in the browser while the Host sees it — which is how `execKind` reached the browser as undefined and made the analysis read `merge` as an AND join.

- Validate definitions completely in `save()` before storing them.
- A workflow's ID is its record file name, so `src/shared/slug.ts` derives it from the workflow name and `update()` re-keys a renamed workflow: it writes the new record before deleting the old one, because an interrupted rename must leave a duplicate rather than lose the definition. An unchanged name keeps its ID, so a record saved under an older naming rule moves only when it is renamed.
- Importing a workflow whose name is taken renames it. Saving reuses the ID of a same-named workflow, so an import that kept the name would replace that workflow on the next save.
- Serialize name lookup and writes so concurrent same-name saves reuse one workflow ID.
- At most one boundary node per side is the only rule they add to validation; everything else about them is ordinary node validation.
- `PortDefinition.default` is declared in `workflowPortSchema`. Zod drops undeclared keys, so a port field missing from the schema is silently lost on save and on load.
- A declared input's `default` is what makes it optional at the call site. `start()` refuses to begin a run when an input has neither a supplied value nor a default, and refuses an undeclared input, so the boundary node always has a value for every port.
- The output node's card shows what the run delivered to each port, read from that node's recorded `inputs` because it declares no output ports of its own. `CardRunValues` is that section for both cards; a second copy of it drifts, and both graphs render the boundary card for a boundary node for the same reason.
- The card declares a new output port optional, because an output fed by one branch of several would otherwise refuse to save. The collected values live in the output node's recorded `inputs` and are lifted onto the run record; that node declares no output ports, so output completeness never applies to it.
- The outputs node takes execution edges like any node, which is the only way a decision can stop a workflow returning anything. Gating is per card, not per port; two exclusive values for one port join through `merge` first.
- Reject `$inputs` and `$outputs` as authored node IDs, and reject an empty or duplicate declared port name: an edge names the port it connects.
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
- The boundary cards are the renderer for two ordinary nodes, so position, selection, deletion and saving all come from the node. A new workflow is seeded with both, and the node library stops offering a side that already exists.
- An edit to a declared port says what it did, so edges follow: a rename moves its edges and a removal takes them with it. A port list alone cannot tell a rename from a removal, and an edge naming a port that no longer exists only fails at the next save.
- Both graphs render `NodeCard`. A card names the node, then its type beside the plugin that registered it, then ports, pins, controls, and the latest run's outputs; a read-only graph passes no `updateConfig` instead of copying the card.
- A node ID belongs in the details panel, and a stage number on the band behind the cards. Either one on a card repeats itself once per node and crowds out what only the card can show.
- Use the shared UI primitive icons and the official `main` and `sidebar.panellist` slots.

## Verification

Run from this directory:

```sh
pnpm test
pnpm build
```
