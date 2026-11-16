# Agent Note: Execution edges

Status: implemented

## Problem

Data edges describe dependencies through values the engine can see. They do not describe dependencies through state it cannot see: the ledger two nodes both write, the budget two branches both spend, the inbox that must not get two questions at once. Without a second kind of edge an author either invents a data port that carries nothing, or accepts whatever order the scheduler picks. Branching has the same gap: deciding "only on approval" through which data happened to arrive makes a run that quietly did nothing look like one that did its work.

## Decision

Every edge declares a `kind`. A `data` edge carries one output port's value to one input port. An `exec` edge carries no value and states control flow; the execution graph is its whole description.

**Pins.** Every node has one execution input pin, `run`, and output pins: `then` unless its type declares `execOutputs`. A node that branches returns `next`, the pins it fired; omitting `next` fires all of them. `execPinFault` in `src/shared/graph.ts` is the one rule for valid execution pins, used by both `save()` and the canvas.

**Three outcomes.** `completed` means every declared output port carries a value, `null` where nothing applies, and the engine checks this, because the registry accepts any object with the right fields and a base-class check would not bind third-party nodes. `skipped` means an inbound execution edge was dead, and nothing else. `failed` covers everything else, including a required input that is absent.

**Skips travel along execution edges only.** An edge is dead when its source did not complete or did not fire its pin. A node with a dead inbound edge is skipped without being called and fires nothing, so the skip continues downstream. A data edge never carries a skip, so a required input whose source may be skipped is a wiring error, and the static analysis refuses to save it.

**Joins belong to the engine.** Every node is an AND join over its inbound execution edges, except the engine's `merge`, an OR join identified by instance so no plugin can claim that rule. `branch` and `switch` are engine nodes too, and a plugin node can declare `exclusiveExecOutputs` to be a decision node that fires exactly one pin; the engine fails a completion that fires any other number, which keeps the analysis' exclusivity conclusions true.

**Scheduling.** A node starts as soon as all its own predecessors, of both edge kinds, have settled, not when a topological level finishes. Gating is decided at that moment, so nothing waits on a pin that can no longer fire. A failed node stops new starts; nodes already started finish, nodes never started are cancelled, and the run fails with the node's error, wrapped in its name. Started work is never abandoned, except a node only waiting for an outside result, which is cancelled because that answer may never come.

## Alternatives considered

**A second `done` pin firing on completion or skip.** It would separate ordering from gating, as systemd's `After=` does beside `Requires=`. Rejected because nodes here are coarse and expected to run on every pass, so a genuinely skipping source is rare, and a node that completes having done nothing says the same with one rule. Adding `done` later is additive.

**Skips crossing data edges.** It keeps branch paths coherent without wiring, and was the earlier behavior. Rejected because the same absent value then means "not this time" in one place and "wired wrong" in another, with no rule to tell them apart.

**Fake data ports for ordering.** It works without engine support, and every node that might need ordering grows a port that carries nothing, so a reader can no longer tell data flow from scheduling glue.

**Join mode declared by node types or by edges.** A public `execJoin` puts a scheduler-wide rule in every node author's hands and hides a merge inside an ordinary-looking card; a per-edge mode gives the rule no single owner the canvas can show. No use case needs either.

**Blueprint's single-token model, or pull-evaluated data pins.** A single token through a single-threaded graph gives up the concurrent approvals this engine runs. Lazy data pins break "every node runs at most once and may have side effects", which the run record, recovery, and `awaitSignal` depend on. BPMN's sequence flows and gateways are the closer model and the one followed here.

## Consequences

A node that does not apply still completes and owes every output, so node authors write `null` outputs rather than skipping themselves. A declared execution pin must be able to fire, or an author can wire a path that never runs. There is no failure pin: a failed node fails the run, so compensation flows are out of reach until the run can survive a failure. Loops are out too: they need run records keyed by iteration rather than node ID, and they would make the `DagEngine` name and the `dag/` events inaccurate.
