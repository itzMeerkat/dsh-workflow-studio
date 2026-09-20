# Agent Note: Execution edges

Status: implemented

## Problem

A workflow's data edges describe dependencies through values the engine can see. They do not describe dependencies through state it cannot: the ledger two nodes both write, the budget two branches both decrement, the audit log whose ordering is itself the compliance artifact, the inbox that must not receive two questions at once. In a purchase-reimbursement pipeline those dependencies are the common case, not the exception, and a workflow author has only two ways to express them today — invent a data port that carries no data purely to force an order, or accept whatever order the scheduler picks.

The scheduler picks concurrency. Two nodes with no data path between them run at the same time, and a failure is only noticed once both have settled, so "run the free policy check before the paid external lookup" cannot be expressed even as an optimization: both already ran.

The one execution control that exists is narrow. The `condition` input port gates a single node on a single boolean, from a single upstream port, through `WorkflowNode.preflight()`. It cannot order two nodes, cannot merge branches — `CoalesceNode` exists to patch the data half of that gap — and it splits the answer to "when does this node run" across the port list, the base class, and the input gate.

Control is also implicit in places it should not be. `inputGate` skips a node when no business input arrived, and propagates a skip when a required input is missing because its source was skipped. A run that quietly does nothing is indistinguishable from a run that did its work, because both end `completed` and a skipped node records no reason.

## Decision

A second edge kind is dedicated to execution: ordering and branching, with looping deferred. The exec graph is the complete and sole description of control flow. Data edges describe only what a node reads.

### Edges

`DagEdgeDefinition` becomes a union discriminated on a required `kind` field, parsed with `z.discriminatedUnion`. `kind: 'data'` is the edge that exists today. `kind: 'exec'` names an execution pin at each end through the existing `sourcePort` and `targetPort` fields.

`kind` is required rather than defaulted so that a definition states which graph each edge belongs to, and so the parser reports a wrong pin against the right variant.

`RunExecutor` indexes the definition's inbound edges by target once per run, split by kind, so an execution edge supplies no input, occupies no input port, and never appears in `connected`. `execPinFault` in `shared/graph.ts` is the single rule for whether an execution edge's two pins are valid; `save()` and the canvas's connection check both call it and only translate the result into their own message.

### Pins

Every node has one exec input pin, `run`, and at least one exec output pin.

An ordinary node has one output pin, `then`, which fires when the node completes. A node that branches declares its own set through `WorkflowNodeExecutor.execOutputs` and chooses which fire by returning `next` on its completed result. Declaring pins replaces `then`, so a branch node does not also fire a generic completion pin. Omitting `next` fires every declared pin, so an ordinary node needs no change. Returning an undeclared pin fails the node.

A pin fires only on completion. A node that is skipped, fails, or is cancelled fires nothing, and every edge leaving it is dead.

### The three outcomes

**Completed** means the node's promised data exists: every declared output port carries a value, whether the node computed it or found it already in place and did nothing. Completion is about the data, not about the work.

**Skipped** means an inbound exec edge was dead, and nothing else. It is the one outcome the engine assigns on its own, and it has exactly one cause, so a skipped node in a run record needs no explanatory field — the predecessors' fired pins say which edge was dead.

**Failed** covers everything else, including a required input that is absent when the node fires. A node declaring a required input asserts that the data is there whenever it runs; if it is not, the workflow is wired wrong or an upstream node lied about completing, and both are errors.

### Skip propagates along exec edges only

A node is skipped when any inbound exec edge is dead. An edge is dead when its source did not complete, or when it leaves an exec pin the source did not fire.

A data edge never carries control. A node downstream of a skipped node by data alone still fires, finds its required input absent, and fails.

That is the point rather than a gap: a node that belongs on a branch path is wired to that branch with an exec edge, and the exec graph alone answers what runs. The alternative — letting a missing value quietly mean "not this time" — is the implicit control this change removes.

### Starvation is rejected at save time

That failure is almost always a wiring mistake, and it is statically decidable while the graph is acyclic.

`assertNoStarvedInputs` computes `guard(N)` for each node in topological order: the set of conditional exec pins that must fire for `N` to run — empty for a node with no inbound exec edges, the union of its exec predecessors' guards for an AND join, and their intersection for `merge`. A pin counts as conditional only when its source declares more than one exec output, because a node with a single `then` pin always fires it on completion. A data edge into a required input is safe when `guard(source) ⊆ guard(target)`, meaning the target runs only when the source ran; anything else is rejected as unwired control flow, and the message names the edge and the pin that makes the source conditional.

The check is conservative: where safety is not provable it rejects, which pushes the author toward drawing the exec edge.

### Every declared output is produced

A node that completes carries a value on every output port it declares. There are no optional outputs: a node with nothing to report writes `null`, and a node whose outputs vary by branch writes `null` on the ports that do not apply.

`resultEnd()` enforces it alongside the undeclared-output check, and treats an `undefined` port value as unproduced rather than dropping it. With that check in place, outputs reaching persistence hold no `undefined`, so the node-output JSON helper that used to drop such ports is gone and `toJsonObject` serializes them.

The check belongs to the engine, not to node authors. TypeScript cannot do it — `ports.outputs` is runtime data and `NodeExecutionCompleted.outputs` is `Record<string, unknown>`, with nothing tying `WorkflowNode<Outputs>`'s generic to the declared port list — and the registry accepts executors by field rather than by inheritance, so a base-class check has a hole every third-party node type can walk through.

What it buys is blame. Without it, a node that silently omits an output surfaces as a missing-input failure on whatever consumes it, and the error names the wrong node; the further apart they sit the worse the diagnosis. With it, the node that broke its promise fails where it stands.

Optional *inputs* remain. `merge` needs them, since its per-branch inputs are dead by construction, and a node that tolerates absent data is making a claim about itself rather than about control flow.

### Conditionality belongs to the node

A node that applies under some conditions and not others completes in both cases. It checks its own precondition and returns `completed`, having done no work, when the condition does not hold. A request-for-receipt node completes without asking when the receipt is already attached.

This holds because this engine's nodes are coarse-grained and expected to be invoked on every run. It costs the node author an output value for every declared port even on the no-op path, which is the price of one rule in the scheduler.

### Joins, and flow control in the engine

An exec input pin is an AND-join, on every node, with no exception and no per-node override. A node runs when every inbound exec edge has fired.

OR-joins exist only as flow-control nodes the engine owns and registers, in `src/flow-nodes.ts`. There are two:

- `branch` takes a boolean `condition` input and fires one of its `true` and `false` result pins. It produces no data: the comparison that feeds it stays in a node plugin, so the engine owns only the fork.
- `merge` is the OR-join: it runs when at least one inbound exec edge fired, is skipped only when all are dead, and passes through the single data input that arrived. It replaces `CoalesceNode` and reuses its variadic input machinery.

`isAnyJoin` compares executor identity against the `merge` singleton rather than matching a type name or a field, so a third-party node cannot claim join semantics even by registering the same type name.

Splitting the two capabilities this way keeps one engine rule for every ordinary node. **Branching is public; joining is not.** A fan-out decision is local to the node that made it and is visible in that node's own record, so any node type may declare result pins. A join rule changes how the scheduler reads the whole graph, so it has exactly one implementation and the author always sees it as a node on the canvas rather than as a property hidden in an inspector.

Because skip propagates unconditionally along exec edges, `merge` is also the only way to rejoin after a branch. Every node that must run regardless of which branch was taken sits downstream of a `merge`, not downstream of either path.

This changes the plugin's former rule that the core plugin registers no nodes. The carve-out is narrow and stated by capability, not by convenience: the engine owns node types whose behavior *is* execution semantics, and nothing else. `DagEngineProvider` registers them in `Service.init`, not the plugin entry point, so any Host that loads the engine can resolve them — including while recovering saved definitions.

An n-way `switch` — amount under 1000 auto-approves, under 10000 goes to a manager, otherwise to the CFO — is the obvious next flow-control node, and needs no new engine concepts beyond the result pins `branch` already uses.

### A node with no exec edges

A node with no inbound exec edges runs whenever the run reaches it. It can fail on absent data; it can never be skipped.

This is what keeps exec edges opt-in per node. A workflow whose ordering is fully described by its data flow needs no exec wiring at all, and adding exec edges to one part of a workflow does not oblige an author to wire the rest.

### Gating is decided when a node becomes ready, so nothing can deadlock

Because loops are out of scope, the combined data-and-exec graph stays acyclic. A node becomes ready only once every one of its predecessors has settled, so the gate is a lookup rather than a wait, and skip propagation needs no fixpoint.

An unsound graph — an AND-join fed from only one side of an exclusive branch — **skips** rather than hangs. BPMN engines deadlock on that shape and need soundness checking to prevent it. Here it degrades to a node that never runs, which the `guard` check above rejects before the run starts.

### Scheduling

Both edge kinds are predecessors. Data edges constrain order because a reader cannot consume a value before it is produced; exec edges add the constraints data cannot express. One graph, one scheduler.

`RunExecutor.execute()` keeps a ready queue: a node starts as soon as every one of its own predecessors has settled, and the gate resolves it to run-or-skip from those predecessors' recorded statuses and fired pins. It does not wait for a topological level, so a long-running node holds up only what depends on it. A node awaiting an external result stays `running` and therefore has not settled, which is what keeps its successors waiting.

Cancelling, a failure, and a pause all act on the queue the same way: they stop new nodes from starting, and none of them abandons a node already started. The run settles its outcome only once the in-flight nodes have finished, so work with side effects is never left half-done and a finished run never records a node still `running`. A pause additionally blocks the scheduler once nothing is running, which is what makes `paused` mean quiescent.

### Persistence

`NodeRunRecord` carries `fired?: readonly string[]`, written by `endNode()`. Without it, a restart cannot gate a node whose branching predecessor completed before the crash without re-running that predecessor, which recovery is forbidden to do. It also carries the taken path to the Runs view, and attributes any skip to a specific dead edge.

`WorkflowRunSummary` carries a skipped-node count, so a run that quietly took a branch is distinguishable from one that ran everything without opening the record.

Both domains are at version 2: `workflow_studio` because exec edges change what a stored definition means, and `workflow_studio_runs` because it embeds the definition schema. Records written under version 1 do not load. Run records are not migrated — a run's embedded definition snapshot is frozen, and there is no reader left for the semantics it froze.

### What was removed

`CONDITION_PORT`, `PortDefinition.role`, and `WorkflowNode.conditional` are gone, along with the gate in `WorkflowNode.preflight()` and the `conditionSourcePort` inference in `createExecutionPlan` and `ExecutionOrderView`.

`NodeExecutionSkipped` left the public result union: a node cannot skip itself, it completes having done no work. `resultEnd()`'s skipped case and the `SKIPPED` constant went with it; the engine still assigns `skipped` for a dead exec edge.

`inputGate` lost both implicit-control paths — the `supplied` heuristic that skipped a node when no business input arrived, and the `skippedDependency` lookup that propagated a skip through data edges. What remains is: any absent required input fails the node.

`WorkflowNodeExecutor.preflight()` is removed. Its only implementation was the condition gate, and with gating in the engine it had no remaining caller. It is worth reintroducing only for a node type that must settle itself before its input check for some reason other than gating.

`IfNode` and `CoalesceNode` are deleted from `dsh-workflow-demo-node`. `IfNode`'s expression evaluation lives on as `CompareNode`, which outputs a boolean for `branch` to fork on — a predicate belongs in a node plugin, the fork belongs in the engine. `HumanApprovalNode` likewise dropped its `approved` and `rejected` boolean outputs for exec pins of the same names, and with them its `onReject` control: a rejected approval fires the `rejected` pin and completes, because a rejection is the process's answer rather than a malfunction. Stopping on rejection is expressed by leaving that pin unwired, which skips the path behind it.

`BranchNode` and `HumanApprovalNode` implement `WorkflowNodeExecutor` directly rather than extending `WorkflowNode`. Both choose their own execution pin, so the base class's `run()` never applied to them and existed only as an unreachable stub. `toFailureResult` is exported for the `NodeFailure` conversion they still want.

### Editor

Exec pins render distinctly from data ports, and every React Flow handle id carries its kind: `data:<port>` or `exec:<pin>`, encoded and parsed through one codec. The prefix is not cosmetic — `edgeDefinition()` reconstructs a definition edge from the handle ids alone, so without it the edge kind is lost on every canvas round-trip. Prefixing *both* kinds rather than only execution pins is what lets a data port be named anything, including something that reads like a pin, without the canvas mistaking which graph it belongs to.

`connectionError` gains two rules — exec pins connect only to exec pins, and an exec input accepts several edges where a data input still accepts one.

`ExecutionOrderView` reads exec edges directly instead of inferring them. Explicit exec edges are never removed by transitive reduction, even when a data path already implies the same order: the author drew it, so it stays on the diagram. Data-derived dependencies keep their current reduction.

### How it landed

Phase 1 was exec edges as ordering and purely additive: `kind`, the `run` and `then` pins, the AND-join gating pass, exec-edge validation, and canvas support, with `condition` untouched and nothing removed.

Phase 2 brought branching and the outcome definitions together: `execOutputs`, `next`, `fired`, the `branch` and `merge` nodes, the output-completeness rule, the `guard` check, and every removal above. They had to land in one change because they are mutually dependent — `IfNode` declared two outputs and produced one, so output completeness could not precede its replacement, and `inputGate`'s skip paths could not go while `condition` still relied on them.

## Alternatives considered

**A second `done` pin firing on completion or skip.** Two output pins per node would separate ordering from gating: `then` meaning "B runs because A succeeded", `done` meaning "B runs after A has had its turn". systemd draws this line between `Requires=` and `After=`, Gradle between `dependsOn` and `mustRunAfter`, Make between ordinary and order-only prerequisites; all three shipped one and later added the other. Rejected because this engine's nodes are coarse-grained and expected to be invoked on every run, which makes a genuinely skipping source rare, and because a node that completes with no work expresses the same thing with one rule in the scheduler and one pin on each card. Reintroducing `done` is additive and does not invalidate anything else here.

**Skip crossing data edges.** Propagating a skip to a node whose required input is missing because its source was skipped — the engine's behavior today — keeps branch paths coherent without exec wiring. Rejected because it puts control flow back in the data graph, which is what this change exists to end: the same absent value would mean "not this time" in one place and "wired wrong" in another, and no rule tells them apart. Requiring the exec edge makes the branch path explicit and lets `save()` reject the omission.

**A `skipReason` discriminant on the run record.** While `skipped` had three causes — node-initiated, input-gate, exec-gate — a record could not say which applied, and an unintended skip was indistinguishable from a deliberate one. Obviated rather than rejected: narrowing `skipped` to a single cause makes the status its own explanation.

**Enforcing output completeness in the node or its base class.** Pushing the check to `WorkflowNode` would keep the engine out of it. Rejected: the registry accepts executors by field rather than by inheritance, so third-party node types bypass a base-class check entirely, and the engine already performs the mirror-image check on undeclared outputs.

**Fake data ports for ordering.** An author can force an order today by adding an output that carries a token and an input that ignores it. It works, and it is what people do when a tool offers nothing else. It also means every node that might ever need ordering grows a vestigial port, and a reader can no longer distinguish real data flow from scheduling glue.

**Two edge kinds, `exec` and `after`.** Splitting gating and ordering into separate edge kinds mirrors systemd and Gradle most directly. Rejected for the same reason as the `done` pin, and additionally because it fragments the mechanism this change exists to consolidate.

**`execJoin` as a public executor declaration.** Letting any node type declare an OR-join would keep every node type in a node plugin and leave the engine with no registrations of its own. Rejected once flow control moved into the engine: it puts a scheduler-wide rule in the hands of every node author, gives join semantics more than one implementation, and hides a merge inside a node whose card looks like any other.

**Join mode as a property of the edge.** Marking individual edges as AND or OR members lets one node mix join rules. Rejected: the rule then has no single owner, the canvas cannot show it, and no use case so far needs a node whose inbound execution is partly conjunctive.

**A `sequence` node.** UE5 needs one because an exec output pin connects to exactly one input. Here a result pin fans out to many targets, which run concurrently, and serializing them is a chain of exec edges. Nothing is left for a `sequence` node to do.

**Copying Blueprint's execution model directly.** UE5 threads a single token through a single-threaded graph and has no join semantics at all: a node runs every time a token arrives. Adopting it would mean giving up the parallel approvals and parallel document checks this engine already runs concurrently. BPMN's sequence flows and gateways are the closer model for a business process, and are what this design follows.

**Pull-evaluated data pins.** Making data edges lazy, as Blueprint does, would let exec flow be the sole source of truth for when anything runs. Rejected: it breaks "every node runs at most once and may have side effects," which the run record, the recovery rules, and `awaitSignal` all depend on.

## Testing

`tests/exec-edges.spec.ts` covers the edge kind end to end: two nodes with no data edge run in the author's order when an execution edge joins them, and share a topological level when none does; two `awaitSignal` nodes joined by an execution edge raise their requests in order; a source that fires no pin leaves its successors skipped, uncalled, with `attempts` at 0, and that skip travels on to their own successors; an execution edge supplies no input and occupies no input port. Its second suite pins the outcome rules: a node completing without a value on every declared output fails, an `undefined` port value fails rather than being dropped, firing an undeclared pin fails, `merge` is skipped only when every inbound execution edge is dead, the run summary reports the skipped count, and an ordinary node records `fired: ['then']`.

`tests/engine-provider.spec.ts` covers the engine-owned nodes and validation: `branch` fires one pin and its unselected path is skipped without being called, a non-boolean `condition` fails the node and the run, `merge` joins both branches and passes through the one that ran, and `save()` rejects a starved data edge — naming the target — then accepts the same graph once the consumer is gated behind the same pin. It also asserts the engine registers exactly `branch` and `merge` and nothing else.

A run interrupted while a node downstream of a completed `branch` was still running, then restarted, gates from the recorded `fired` without calling the branch node again — the durable half of the branching rules. A chain of nodes unrelated to a node blocked on `awaitSignal` runs to completion while that node is still `running`, which a level barrier could not do.

`save()` rejection is covered for an execution edge naming a pin that does not exist, a duplicate execution edge between the same pins, an edge without `kind`, and a cycle formed by data and execution edges together. `tests/graph-model.spec.ts` covers the canvas: an execution edge round-trips through load, drag and save with its kind intact, execution pins pair only with execution pins, and an execution input is never reported as occupied. `tests/client-model.spec.ts` covers reduction keeping an execution dependency a data path already implies.

## Consequences

**A no-op node owes every output.** Completing with no work means writing a value on every declared port, `null` where nothing applies. `HumanApprovalNode` shows the shape: it returns `output` and `comment` on both paths and distinguishes them by pin. This is the standing cost of moving conditionality into nodes, and it belongs in the node-authoring skill rather than only here.

**A node cannot always choose to complete instead of skipping.** A node reached by a dead execution edge is never called, so node-level conditionality only covers the cases the node is asked about. That is the intended division: the graph decides whether a node runs, the node decides whether its work applies.

**A node that declares an execution pin must be able to fire it.** `HumanApprovalNode` first kept its `onReject` control alongside the new pins, so with the default setting its `rejected` pin could never fire and a rejection failed the whole run — an author could wire a reject path that silently could not run. A pin whose firing depends on configuration is a trap; configuration that decides control flow belongs in the graph instead.

**The `guard` check is conservative.** Where it cannot prove a data edge safe it rejects, so a legitimate graph can be refused and have to be wired more explicitly than its author thinks necessary. A rejection names the edge and the pin that makes the source conditional, so the fix is mechanical.

**The missing-required-input failure is normally unreachable.** With the `guard` check passing and every completed node producing all its outputs, a required input can be absent only if its source did not complete — which means the target was skipped or the run already failed. `inputGate` keeps the failure path as an assertion against a defect in the guard computation, not as an expected outcome.

**Ordering costs only what it constrains.** An execution edge makes its target wait for its source and for nothing else. The scheduler originally advanced a topological level at a time, so every node in a level waited for the slowest one whether or not it depended on it, and an execution edge dragged everything behind its target along with it: one 1000 ms node beside an independent five-stage 100 ms pipeline took about 1400 ms against a 1000 ms critical path. The ready queue removed that penalty — the same workload measures about 1030 ms — which matters most for the shape this engine is built for, where a human approval or an agent call runs for minutes beside unrelated work.

**More concurrency means more interleaving.** Nodes that once ran in separate levels can now overlap, so a test that assumed level boundaries can see a different order. Prefer a blocked `awaitSignal` node over a sleep when a test needs one node to still be running while another finishes.

**No failure pin.** A failed node fails the run, so nothing downstream runs at all. Compensation and rollback flows will want more, and will need the run to survive a node failure first — a separate decision.

**Stored workflows and runs from version 1 are discarded.** The domain version bump makes every definition and run record written before this change unreadable. That was acceptable because the plugin had no installed base to protect; it would not be acceptable again.

## Deferred

**Loops.** They need run records keyed by execution instance rather than by node ID, iteration-scoped `invocationKey` and `notepad` — `invocationKey` is contractually stable across calls, so a human-input node inside a loop would return the first iteration's answer forever — a ready-queue scheduler, explicit back-edge marking, and an iteration bound. That is a new run model, and adding it changes the run-record format a second time.

**An n-way `switch`.** Amount under 1000 auto-approves, under 10000 goes to a manager, otherwise to the CFO. It needs no new engine concepts beyond the result pins `branch` already uses.

**An unreachable-node lint in the editor.** The `guard` check rejects starved data edges, but a node whose only execution predecessor sits on a mutually exclusive branch is merely never run. `fired` makes such a case attributable after a run; catching it before one is editor work.

**`DagEngine` is named for an acyclic graph.** The name stays accurate while loops are out. Loops would make the service name, the `dag/` event namespace, and the README framing wrong at once.
