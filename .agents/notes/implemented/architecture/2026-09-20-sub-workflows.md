# Agent Note: Sub-workflows by expansion

Status: implemented

## Problem

Workflows repeat themselves: the same three-node approval chain appears in every purchase flow. Copying it means every fix is made once per copy. A workflow should be usable as one node of another, linked rather than copied, so editing it reaches every place that uses it.

## Decision

A workflow's interface is its two boundary nodes: the `workflow-input` node's output ports are its inputs, the `workflow-output` node's input ports are its outputs. A `subworkflow` node stores only the embedded workflow's ID in `config.workflow`.

**Ports follow the embedded workflow.** `withSubworkflows` (`src/shared/subworkflow.ts`) writes every subworkflow node's ports from its workflow's boundary nodes, an input with a default becoming optional, and drops data edges on ports that no longer exist. `create_workflow` runs it before saving; the panel runs it whenever a workflow is opened or the saved workflows change, and the canvas runs it on every node edit through `editNode`, applying the refreshed ports to every subworkflow node whose ports moved, not only the one edited. A workflow whose embedded workflow is missing keeps the ports it had, so wiring survives a list that has not loaded yet.

**A run expands sub-workflows at start.** `expandSubworkflows` (`src/subworkflow.ts`) replaces each subworkflow node `S` with the embedded workflow's saved version: an entry node that keeps `S`'s ID and inbound edges and hands its values, plus the defaults of unwired inputs, to the embedded nodes; those nodes renamed `S/<id>`; and an exit node in place of its output boundary. The entry gates every embedded node except OR joins, so the whole sub-workflow waits for its inputs and is skipped with `S`. Edges leaving `S` leave the node that produced each value, or the exit for execution edges. The run's definition snapshot is the expanded graph.

**Only the expansion places the entry and exit nodes.** They are listed in `EXPANSION_NODE_TYPES`; saving refuses them in an authored definition and the node menu leaves them out.

**Embedding cannot form a cycle.** The panel disables workflows that already embed the edited one (`embedsCycle`), and expansion refuses a cycle by tracking the workflow IDs on the current path, so a cycle saved by another route fails when a run starts rather than looping.

**A failure names its path.** A node failing inside a sub-workflow fails the run with its error wrapped first in each enclosing sub-workflow's name, as `add-offset: sum: …`.

## Alternatives considered

**The child as its own run.** The subworkflow node would start a second run and await it. Each part of the durability model would then need a parent–child version: recovery would start the child twice unless the node saved its run ID first; cancel and pause would not cross the link; a child waiting for an answer would leave the parent looking stalled; retention could delete a child its retained parent points at; and the child would run whatever is saved at call time rather than the parent's snapshot. Expansion keeps one run, so all of those apply unchanged. It is still the right design when a sub-workflow needs its own run history or lifecycle, and it can be added as a second calling node type, because the workflow interface is the same.

**Inlining the child at save time.** The parent would hold a copy, and editing the child would not reach the workflows that use it, which is the duplication this exists to remove.

**Binding workflow ports to `{nodeId, port}` pairs in the definition.** The canvas would need a second way to draw a relation it already draws; a boundary node is positioned, connected, and skipped like any node.

**A node type per saved workflow, such as `sub-workflow:<id>`.** The canvas would need no subworkflow knowledge, but the node catalog would change on every save, and the link would live in the type name instead of in data the card can edit.

## Consequences

A sub-workflow has no run history of its own; running it alone means running it as a top-level workflow. The Runs tab shows the expanded nodes while the canvas shows one node. An embedded workflow's ID cannot change while it is embedded, see [workflow IDs](2026-09-20-workflow-identity.md). The run record carries the expanded graph, so a run keeps the sub-workflow version it started with even after the embedded workflow is edited.
