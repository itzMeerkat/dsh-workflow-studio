# Agent Note: Static analysis and the pseudocode description

Status: implemented

## Problem

Per-edge validation cannot see across branches. Whether a data edge's source has always run when its target runs, whether a `merge` receives exactly one value, whether an output has a value on every branch: each needs the whole graph. Without that, a wiring error surfaces only on the run that takes the unlucky branch. Separately, a graph of nodes and edges is slow to read, for a person scanning the canvas and for a model reading JSON.

## Decision

**One analysis, run by both sides.** `analyzeWorkflow` (`src/shared/analysis.ts`) reads a definition and the node catalog and nothing else. For each node it computes a guard, the set of execution pins it depends on firing; from guards and the catalog it reports starved inputs, output gaps, `merge` overlaps and gaps, and types that inference narrowed into a mismatch. The Host runs it on every save and on the expanded graph at run start; the browser runs the same function on the unsaved canvas, so a refusal is visible before Save is pressed.

**Errors only for what is always wrong.** The analysis knows nothing about which pin a run will fire, so a diagnostic refuses saving only when the wiring is wrong under every branch outcome, which is a required input whose source may be skipped. Everything it cannot prove is a warning on the card and in the checks list. A warning that blocks a correct graph would be worse than the run-time failure it replaces.

**Derived, never stored.** Guards, diagnostics, and the IR are recomputed from the definition whenever they are needed. A stored plan would go stale on the next edit, and the registry can gain node types between save and run.

**The IR orders the graph for reading.** `buildWorkflowIr` (`src/shared/ir.ts`) places each node under exactly its guard and after all its upstream nodes, choosing among valid orders only to keep condition blocks few, and records where each argument comes from.

**The description writes the IR.** `describeWorkflow` (`src/shared/description.ts`) turns the IR into indented pseudocode: a node is a call to its type with its data edges as named arguments, a node with outputs is assigned to its name, decision pins become `if`/`else if`/`else` on `node.pin`, a subworkflow node calls the workflow it embeds, and values reaching the output node become `out:` assignments. Nodes are named by label, else type, else ID when the name is not unique. It never refuses: every graph the analysis accepts has a description. `describe_workflow` returns it to the model, with the analysis warnings, and the panel's Description tab shows it for the unsaved canvas.

## Alternatives considered

**Rejecting everything the analysis cannot prove.** Simpler to explain, and it blocks correct graphs whose branches only the run can resolve, such as two branches of an approval that always meet again.

**Checking per edge, as validation does.** The question "has the source run whenever the target runs" has no per-edge answer, which is why the analysis exists. Validation keeps the per-node and per-edge rules, and the analysis does not repeat them: it reports a type mismatch only where inference narrowed a declared `any`.

**A separate browser implementation.** The panel could check with its own code, and two implementations of one rule drift; the execution-pin rule once diverged that way, leaving branch pins unconnectable on the canvas while saving accepted them.

**Describing the graph by walking it directly.** Without an IR, ordering and block structure would be decided while writing text, mixing what the workflow does with how it is spelled. The IR keeps the hard part, valid order under the right guards, testable on its own.

**Compiling workflows to executable code.** It would give up what the engine is for: per-node records, durable waits, recovery, pause and cancel. The analysis informs execution and never replaces the scheduler; see [the removal of code generation](../simplification/2026-11-15-remove-code-generation.md) for the generator that once shared this IR.

## Consequences

The analysis requires an acyclic graph whose node types are all in the catalog and whose edges join existing nodes; the Host validates first, and the browser does not analyze, or describe, a graph that breaks any of these, because the cards and the execution view already show each fault. `workflowStudioSnapshotSchema` must carry every catalog field the browser analysis reads, since zod drops undeclared keys and a missing field silently changes the browser's conclusions. The description is a reading aid, not a format: its spelling can change without migrating anything.
