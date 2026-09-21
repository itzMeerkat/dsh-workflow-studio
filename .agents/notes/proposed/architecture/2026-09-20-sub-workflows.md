# Agent Note: Sub-workflows

Status: proposed

## Problem

A workflow is a closed program. `start(workflowId)` takes no arguments, and a finished run reports node records rather than a result, so nothing outside the run can supply a value to it or read one from it. A sequence that recurs — collect a document, summarize it, file the summary — is therefore copied into every workflow that needs it, and a correction has to be repeated in every copy. There is no way to name a graph and call it.

`DagWorkflowDefinition` already declares `inputs` and `outputs`. Both are parsed by `workflowDefinitionSchema`, stored, and returned; no code reads either one. The declaration anticipates this note and constrains nothing today.

## Proposal

### The interface a workflow exposes

`definition.inputs` and `definition.outputs` become the workflow's ports, and two node types bind them to the graph. `workflow-input` takes a `config.port` naming one declared input, has no input ports, and has one output carrying the value the caller supplied. `workflow-output` takes a `config.port` naming one declared output, has one input, and has no outputs.

`save()` gains the matching checks: every `workflow-input` and `workflow-output` names a declared port, and every declared port has exactly one boundary node. A workflow that declares no ports keeps working unchanged, so every workflow saved today stays valid.

These two node types belong to the engine, next to `branch` and `merge`, because passing a run's parameters is execution semantics rather than business logic. They are also the only node types whose behavior depends on values the engine itself holds.

### Calling a workflow

A `sub-workflow` node selects a saved workflow through `config.workflowId`. Its ports are the child's declared ports, carried on the node instance through `DagNodeDefinition.inputs` and `outputs`, which already override an executor's declared ports — the mechanism `variadicInputs` nodes use. The registry therefore needs no new feature for a node type whose ports vary per instance.

### Where the child runs

Two mechanisms can execute the child, and they differ in cost by a large margin.

**Option A — the child is its own run.** `start(workflowId, inputs)` seeds the `workflow-input` nodes, `WorkflowRunRecord` gains an `outputs` field collected from the `workflow-output` nodes, and the `sub-workflow` executor calls `start` and awaits `DagRun.result`. Five separate problems follow from the parent and the child being different runs:

1. **Recovery starts the child twice.** The calling node is `running` while the child runs, so after a Host restart its `recovery: rerun` policy calls it again and it starts a second child. Avoiding that needs the node to save the child run ID to its notepad before awaiting, and needs the engine to offer a way to await a run it did not just start. No such method exists: `DagRun.result` is handed out by `start` alone.
2. **Cancel and pause do not cross the link.** `cancelRun(parent)` aborts the calling node's `context.signal`, and the child keeps running until that node explicitly cancels it. `pauseRun` has no cross-run meaning at all, because pausing is one scheduler declining to start new nodes.
3. **A waiting child looks stalled.** A node inside the child that calls `awaitSignal` raises its request against the child run. The parent's `pendingRequests` does not count it and the Runs tab offers no route from the parent to it, so the parent shows a node running with nothing to answer.
4. **Retention deletes children.** `pruneRuns` drops the oldest finished runs beyond `retainRuns` without knowing one of them is the child a retained parent points at.
5. **The parent's snapshot stops describing the run.** A run snapshots its definition at start, but a child resolved by ID at call time runs whatever is saved at that moment.

**Option B — the child is expanded into the parent's graph.** `start()` replaces each `sub-workflow` node with the child's nodes and edges under an ID prefix, `<callerNodeId>/<childNodeId>`. The child's `workflow-input` nodes take the values from the caller's inbound data edges, its `workflow-output` nodes feed the caller's outbound data edges, and the caller's execution pins attach to the child's entry and exit nodes. The expanded graph is what the run snapshots and what the run record lists.

All five problems disappear, because there is one run. Checkpoints, at-least-once recall, `fired` pins, waiting requests, pause, cancel, pruning, and the definition snapshot apply unchanged to nodes that happen to have slash-separated IDs.

Option B gives up three things instead. A sub-workflow has no run history of its own; running one alone means running it as a top-level workflow, which still works. The canvas shows the caller as one node while the Runs tab shows the expanded nodes, and the execution-order view derives from the definition, so it shows the unexpanded caller unless it is handed the expansion too. Recursion must be rejected during expansion, by tracking the workflow IDs on the current expansion path, together with a depth limit that is a `Config` field rather than a constant.

**The recommendation is option B first.** The engine's durability model is written for one run; option A needs a second version of each part of it for the parent–child link, and each of the five problems above is a separate piece of engine surface. Option A is worth building when a sub-workflow needs its own run history or its own lifecycle, such as pausing a child while its parent continues, and it can be added then as a second calling node type, because the workflow interface is the same for both.

### Order of work for option B

1. `flow-nodes.ts`: `workflow-input` and `workflow-output`, with the port checks in `validation.ts`.
2. A new `src/expand.ts`: ID namespacing, boundary binding, recursion rejection, depth limit.
3. `engine-provider.start()`: expand before creating the run state; collect `WorkflowRunRecord.outputs` when the run completes.
4. `tools.ts`: `run_workflow` accepts input values and `get_workflow_run` reports the outputs, which makes a saved workflow callable by a model as a parameterized operation.
5. Client: the caller node's ports follow the selected child, and the node library offers saved workflows alongside registered node types.

## What a first implementation revealed

Option B was built once and set aside as premature; the work is on the unmerged `sub-workflows` branch. These are the findings worth keeping, because each one cost a failing test to discover and none of them is visible from the design above.

- **A `workflow-input` node with a configured default is an optional port at the call site; one without a default is required.** Projecting every input as required makes a call unusable: every caller has to wire every input, and a default value can never apply. This rule is what makes a defaulted port mean anything.
- **Validation has to resolve the definition being saved under its own ID.** Otherwise a self-call reads the definition it is about to replace, finds no call in it, and the cycle is only caught when the workflow runs — after the landmine is stored. This also means validation belongs inside the mutation queue, where the allocated ID is known.
- **A call expands to two generated frame nodes, not one.** The entry frame takes the call site's inbound edges, the exit frame supplies its outbound edges, and the entry frame must gate *both* the exit frame and every child node that has no execution predecessor of its own. Without that gating a dead execution edge at the call site leaves the child's nodes running and failing on missing inputs, because a skip travels only along execution edges — the boundary nodes alone do not carry it.
- **A called workflow's `workflow-output` node cannot sit behind a branch.** The exit frame requires every declared output, so `assertNoStarvedInputs` rejects the expansion. Joining the branches with `merge` first is the fix, and the rejection is the right behavior: a call must always produce its declared outputs.
- **Deleting `DagWorkflowDefinition.inputs` and `outputs` is part of the change, not a separate cleanup.** Keeping them beside the boundary-node projection creates a second source of truth for the same fact.
- **Node IDs must exclude `/` and `#`**, which expansion reserves to tell a workflow's own nodes from a called workflow's.
- **The browser needs no changes at all** once a call is a node of type `sub-workflow:<workflowId>` and the controller synthesizes one catalog entry per saved workflow. Storing the target in `config` instead would have forced the canvas to learn what a sub-workflow is, and would have let a call keep stale ports after its target changed interface.
- **Renaming a workflow must retarget its callers in the same mutation**, because a workflow ID is now derived from its name.

## Alternatives considered

**Binding workflow ports to `{nodeId, port}` pairs recorded in the definition**, with no boundary nodes. Rejected: the canvas would need a second way to draw a relation it can already draw, while a boundary node is positioned, connected, and skipped like every other node.

**A calling node that inlines the child at save time** rather than at start. Rejected: the parent would then hold a copy, and editing the child would not reach workflows that call it, which is the duplication this note exists to remove.

## Acceptance criteria

- A workflow that declares `inputs` and `outputs` runs standalone with values supplied to `start()` and reports its outputs on the finished run record.
- A parent workflow calling a child produces one run whose record lists the child's nodes under namespaced IDs, and the parent's node receives the child's outputs.
- Saving or starting a workflow that reaches itself through any chain of `sub-workflow` nodes is rejected, naming the chain.
- A Host restart in the middle of an expanded child recovers exactly like a restart in the middle of any other node: completed child nodes are not called again.
- A node inside a child that calls `awaitSignal` raises its request on the single run, and the Runs tab answers it without any new routing.

## Risks

- Node IDs grow with nesting depth, and a run record for a deeply nested workflow lists every expanded node. The depth limit is what keeps this bounded.
- Editing a child between saving a parent and running it changes what the parent does. The expanded snapshot records what actually ran, so the change is visible after the fact but not before.
- The execution-order view and the canvas disagree about how many nodes a workflow has until the view is given the expansion, which is editor work this note does not cost out.
- Giving up an independent child run means a long-running sub-workflow cannot be paused or retained separately from its parent. Option A remains available for that case and is not foreclosed by building option B.
