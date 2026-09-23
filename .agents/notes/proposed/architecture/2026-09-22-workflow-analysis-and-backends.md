# Agent Note: Workflow analysis and its backends

Status: implemented; the code backend was reshaped afterwards, then merged with the projection into one generator (see the end)

## Problem

Validation decides one node or one edge at a time. `resolveExecutors` checks port names, duplicate IDs, execution-pin names, variadic constraints and required-input connectivity, and `topologicalSort` rejects cycles. Every one of those questions is local, so the errors that survive validation are the ones that depend on the whole graph, and they surface as a failed node partway through a run that has already spent minutes and an agent session.

One such conclusion is already drawn, and it shows both the value and the gap. `assertNoStarvedInputs` in `validation.ts` labels each node with the condition pins it depends on and refuses a data edge whose source may be skipped while its target still runs — the failure `inputGate` would otherwise report mid-run. It is a whole-graph pass living inside per-rule validation, reachable only from the Host, and it answers one question of several.

The questions it does not answer follow from the same engine semantics:

- **A `merge` that receives the wrong number of inputs.** `MergeNode` raises `NodeFailure` unless exactly one input is delivered, so a merge whose two sources are not mutually exclusive is a latent failure that only the right branch outcome reveals.
- **Workflow outputs that a path never fills.** Execution-edge gating is per output card, not per port, so which declared outputs a run delivers depends on the path taken, and no one can read that off a canvas with three branches.

A second gap has the same root. A workflow has no textual projection. A definition diff is node positions and IDs, a reviewer cannot read a graph in a pull request, and explaining a workflow to a model means handing it the whole JSON.

Both gaps are whole-graph questions about a definition, which is what an analysis pass answers.

## Proposal

Add one analysis front end over `(DagWorkflowDefinition, readonly NodeTypeSummary[])`, and give it more than one consumer.

The input is deliberately the definition plus node-type summaries, never resolved executors. `WorkflowStudioSnapshot.nodeTypes` already carries every field the analysis needs — ports, `execOutputs`, `variadicInputs` — so the same pass runs in the Host during `save()` and in the browser against the canvas the author is editing, with no round trip and no second implementation. It belongs in `src/shared/`, which is defined as the modules both faces load.

### The facts it computes

Every fact derives from one relation: under which conditions does a node run.

A path predicate over branch outcomes, where an atom is a `(branchNodeId, pin)` pair, labels each node. A node with no inbound execution edge always runs, because `gateSkipped` returns false for it, so its predicate is `true`. An ordinary node is an AND join, so its predicate is the conjunction of its inbound edges' predicates; an OR join — `merge`, identified by `isAnyJoin` — is their disjunction. An execution edge out of a `branch` contributes its own pin atom. Propagation follows the existing topological order, so the pass is linear in the graph.

From that relation:

- **Must-run.** For a data edge, the source must run whenever the target does: the target's predicate must imply the source's. A counterexample is a branch outcome under which the target runs and the source is skipped, which is exactly the failure `inputGate` reports at run time.
- **Exclusivity.** For a `merge`, each pair of sources must have predicates that cannot hold together, and at least one must hold on every path that reaches the merge.
- **Output coverage.** For each declared workflow output, the branch outcomes under which nothing fills it.
- **Types.** Forward inference along data edges with `any` as the top element, joining through `merge`'s `outputType: 'same'` and through variadic inputs, which `portsAreCompatible` cannot do pairwise.

### Rules the pass lives under

**Derived, never stored.** A cached plan is a second source of truth that goes stale on edit. The pass runs on save, again at run start because the registry can gain node types in between, and continuously in the browser while editing.

**Conservative, and reported as warnings.** `branch` chooses its pin at run time, a node may override its ports from config, variadic arity varies per instance, and an agent node is opaque. Some real graphs will not be provable. Those raise a warning on the node card. A diagnostic becomes a hard error that blocks saving only when the graph is wrong under every branch outcome, which is the case for a data edge whose source is skipped on every path that reaches its target.

**Runs stay interpreted.** Compiling a workflow into executable code would give up the reason the engine exists: checkpointed per-node records, `notepad` and `awaitSignal` surviving a Host restart, at-least-once `rerun` recovery, pause, cancel, and the Runs tab built on those records. The analysis informs execution; it never replaces the scheduler.

## Milestones

Milestones 1 to 5 improve workflows that are executed. Milestone 6 is the seam, and milestone 7 is the first consumer that emits code rather than diagnostics.

**M1 — lift the must-run relation out of validation.** `src/shared/analysis.ts` takes over the guard pass from `assertNoStarvedInputs` and reads node-type summaries rather than executors, so the browser can run it too. The refusal it already produced is preserved exactly; what changes is that one module now owns the relation every later milestone builds on. `NodeTypeSummary` gains `execKind`, derived by the registry from executor identity, because a summary is all the browser has and `isAnyJoin` compares instances.

**M2 — exclusivity and output coverage.** The `merge` pairwise check and the per-output uncovered-path report, on the same predicates. Both turn a run-time `NodeFailure` into an edit-time diagnostic.

**M3 — the pseudocode projection.** A pure `project(definition, nodeTypes): string` rendering the graph as indented pseudocode: execution edges become statement order, `branch` becomes `if`/`else`, `merge` becomes the join, data edges become named values. Exposed as a `describe_workflow` tool and as a read-only panel tab beside the execution-order view. It makes workflows reviewable, diffable, and explainable to a model. It is also the first backend over the analysis, which is what makes the next split cheap.

**M4 — type inference.** Forward inference with `any` as top, replacing pairwise `portsAreCompatible` at the edges the inference can decide. Warnings only, because port types are documentation today and existing saved workflows must keep loading.

**M5 — diagnostics in the panel.** The browser runs the same pass against the edited canvas and marks the offending card and edge, with the list in the inspector. Nothing new is computed here; this is where the earlier milestones become visible while authoring.

**M6 — extract the IR.** The point where the second backend begins. `src/shared/ir.ts` lowers a definition to execution order, condition blocks, and each argument's source, and the projection became its first backend. Nothing user-visible changed, so the projection's existing tests were the regression test: byte-identical before and after.

Two expectations from the plan did not survive contact. The diagnostics are *not* an IR consumer: they need the guard relation, not statement order, so the IR consumes the analysis rather than the other way round. And scope placement needs no dominance computation of its own — a node's guard already names the block it belongs to, so the only value needing more is the OR join, whose sources are written in exclusive blocks and read after them. Where that name is introduced is a property of the target language, not of the graph, so it belongs to the backend and the IR stays free of it.

**M7 — the code-generation backend, in `dsh-workflow-demo-node`.** `code-expression` and `code-statement` carry a snippet whose `{{port}}` holes take the values their input ports receive; both fail loudly if a run reaches them. `compileWorkflow(ir, backend)` emits one function — workflow inputs as parameters, declared outputs as the returned record, `branch` as `if`/`else`, `merge` as a name introduced before the arms and assigned inside them — and `compile_workflow` exposes it. Python and TypeScript each implement one `LanguageBackend`, which was the test of whether the IR really carries no language decision; the split it forced was between introducing a name and assigning to one, identical in Python and distinct in TypeScript. Scope stops at straight-line code, expressions and `if`/`else`: no loops and no functions, because a body is a subgraph and that is the sub-workflow mechanism, which arrives separately.

## Consequences

The engine gains no new execution semantics, and the scheduler is untouched. The cost is one shared module plus its consumers, and the obligation to keep it conservative: a diagnostic that blocks a correct graph is worse than the run-time failure it replaces, so every hard error needs a graph proving the failure is unconditional.

Code generation stops being a separate project. It becomes a fourth consumer of a pass the executed workflows wanted anyway, which is the argument for building the analysis first and in the engine rather than in the node plugin.

## What changed after the milestones

Three decisions replaced the shape milestone 7 shipped with.

**A code node carries raw code.** The `{{port}}` holes and the input ports behind them are gone: a section of code declares nothing about what it reads or writes, and the compiler does not parse it. The graph decides the order the sections are written in and which branch each belongs to, and nothing else. Wiring values between sections is deferred rather than designed away — it needs names that both sides agree on, which is a separate decision from placing code.

**A workflow has a kind.** `run` workflows are scheduled and executed; `code` workflows are compiled and never run. The kind decides which node types a workflow may use, because a node type now declares which kinds it belongs to, defaulting to `run`. That default is what lets every node written before this change keep working and keeps a code node out of an executed workflow. `workflowDefinitionSchema` defaults the kind, so records written before kinds existed read back as `run` without any code asking whether the field is there.

**Compiling is a seam, not a plugin's private feature.** `ctx.workflowCompilers` takes a `LanguageBackend`; the Studio owns the walk over the IR and registers no language, exactly as it registers no node. That is what lets the Code panel show generated source without the engine depending on the plugin that supplies the dialect, and it is why the panel is the Studio's rather than the node plugin's.

Each kind has its own sidebar entry, both opening the same editor with a different kind: the kind decides which workflows are listed, which node types the library offers, and which views exist. Reusing one panel keeps the workflow list, canvas, save, import and export in one place; what the two kinds genuinely do not share is where a workflow ends up, which is one view each.

## One generator for both kinds

The projection and the compiler turned out to be the same walk over the IR: indent by depth, open a block per guarded arm, write each item. What differed was which syntax a block is written in and what an item becomes, and those are two independent axes. `src/shared/source.ts` now owns the single walk; a `LanguageSyntax` fixes the block syntax, and the workflow kind fixes the content — a `run` node is a call to its type, a `code` node is its code. Pseudocode is the built-in `PSEUDOCODE` syntax for `run` workflows, not a separate projection, so it now writes `if`/`else` exactly as compiled code does.

A syntax is data rather than functions. Every function a `LanguageBackend` had was a string template, and data travels in the editor snapshot, so the browser renders the unsaved canvas in any language instead of asking the Host to compile the last save. That removed the `languages` and `compile` Remote methods and the Code view's save round trip, and it let `describe_workflow` take a language and replace the plugin's `compile_workflow`. `ctx.workflowLanguages` replaces `ctx.workflowCompilers`, and a language declares the kinds it can write, as a node type does.

Merging the walkers exposed an ordering fault in the IR. It grouped every node by its guard and placed each group where the guard first appeared, which writes a node inside a branch before an upstream node that follows the branch — a `merge` after the `if`/`else` feeding a node gated by one arm. The IR now takes a topological order that prefers keeping the current block open and then the other arm of the same decision, and opens blocks as that order demands; the output is correct for every graph and one condition may appear in two blocks when the dependencies require it. The IR takes the analysis as an argument rather than recomputing it, so the editor analyzes once per edit.

## A code workflow is written in one language

A `code` node's code is text in one language, so offering every language in a picker only changed the wrapper around it: a Python section rendered as TypeScript was never TypeScript. The definition now names its language, the Source view and `describe_workflow` write that one language, and the code panel's toolbar chooses it.

Go added the `code-function` node: its code is a function, and its parameters and results are the node's ports. The ports have to follow the code while it is typed, which needs a signature reader in the browser, and a plugin cannot ship browser code. So the languages became code in Studio, together with the `code` node types they read, and `ctx.workflowLanguages`, the snapshot's `languages` and their schema were deleted. A language without `functions` (Python, TypeScript) cannot hold a function node, and the generator says so instead of guessing.

The generator reads the signature again rather than trusting the ports stored in the definition, so a hand-edited definition cannot make a call disagree with its function. Every result something reads is declared at the top of the generated function and assigned where the call sits, because a value assigned inside one branch and read after the `merge` must outlive the branch; a `merge` of function results is that one variable, which every branch assigns. Results nothing reads are discarded, since Go rejects a variable that is declared and never read.

## Atom folders

A Go workflow may name an atom folder: a Go package on the Host whose every file defines one function with its imports and globals. Each file becomes a node the workflow can use, but not a registered node type. The registry is global while a folder belongs to one workflow, so two workflows with different folders would collide. The library entries are generated per workflow in the browser, and every one of them is a `code-atom` node whose configuration is only the file name.

The node stores the file name, not the code, so the folder stays the source of truth: reading it again moves the nodes' ports, and the generator copies the current imports, globals and function into the output. The Host reads the files and the shared parser runs on both sides, so the wire carries only file names and text. Choosing a folder uses a folder listing from the Studio Host rather than the Harness directory picker, which exists only when a composition mounts one of its backends.

The folder is one Go package, so the generated function belongs in it. Saving writes only that function, as `workflow.go`, beside the atoms, and it calls them by name: nothing is copied, so the atoms' imports and globals stay in their own files, and `go build` checks the whole flow. The function imports only the packages its own text names, because Go rejects an unused import. Saving renders first and refuses a workflow it cannot write, so a saved workflow always matches its file.

Atoms replaced the `code-function` node, which held an inline function in the definition: a folder of files serves the same purpose, and it is also the package the output needs.
