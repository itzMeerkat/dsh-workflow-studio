# Agent Note: Remove code generation

Status: implemented

## Problem

From 2026-09-22 Studio had a second kind of workflow. A `code` workflow was never run: it named a language, Go, and an atom folder on the Host, a Go package whose files each exported one function. Its nodes were `code-block` statements, `code-condition` expressions, and `code-atom` calls to those functions, and saving wrote the graph into the folder as `<id>.workflow.go`. The motivation was to let a model take existing code apart into atoms and rebuild it as a graph a person can review and rearrange, with the graph as the source of truth.

That one feature reached into almost everything. Workflows carried `kind`, `language`, and `atomFolder`; node types declared which kinds they belonged to; port types could be any Go type; the browser parsed Go signatures to draw ports; a `workflowFiles` service kept generated files and their embedders' files current on every save; a bundled skill taught the model the atom rules; and the generator shared one walk with the pseudocode description, so the description carried a language abstraction, identifier rules, and failure cases it never needed. Code generation is out of scope for Studio's design, which is about running workflows, so all of that cost buys nothing the product wants.

## Decision

Code generation is removed entirely: workflow kinds, languages, atom folders, the Go reader, the three code node types, `workflowFiles` and the written files, the `workflow-code-atoms` skill, the Atoms panel and folder browser, the language picker, editing a node's own ports in the inspector, and every refusal and string about them. The Remote has no `atomFiles` or `folders` methods, and a save returns only `{ workflowId }`.

The pseudocode description stays, rewritten as its own writer; see [static analysis and the description](../architecture/2026-09-22-analysis-and-description.md). Port types offered in the editor are the four built-in ones; a port that declares another type keeps it.

**Older records still load.** `workflowDefinitionSchema` drops undeclared keys, so a record or run snapshot carrying `kind`, `language`, or `atomFolder` reads back without them, with no domain version bump. A former `run` workflow is unchanged. A former `code` workflow opens with its code nodes as unknown node types, and saving it is refused with `node-type-unknown`. Generated `.workflow.go` files already in atom folders are left alone; nothing reads or deletes them any more.

**Expansion-only nodes need a new guard.** Node kinds had also kept authors from placing the sub-workflow entry and exit nodes, which belonged to no kind. They are now listed in `EXPANSION_NODE_TYPES`, saving refuses them with `node-reserved`, and the node menu leaves them out.

## Alternatives considered

**Keep the generator, drop only the Go backend.** The `Language` abstraction and the `code` kind would stay for a future language. Rejected: with no language behind it, the abstraction is speculative code every change still has to respect, and the description is simpler without it.

**Move code generation into a separate plugin.** The kind field, node kinds, and the save hook would have to stay in Studio as extension points for one consumer, which keeps most of the cost while hiding it.

**Hide the feature in the panel but keep the data model.** It removes nothing from the code that every change touches, and leaves durable fields no user can set.

## Consequences

Studio gives up turning a graph into compilable source and rebuilding existing code as a graph. Reintroducing it is reasonable only if Studio's purpose comes to include code authoring, and then as a separate kind of artifact with its own editor, not a flag on a run workflow: the coupling recorded above came from making every workflow carry the possibility.

Verification that the feature is absent: Studio's tests pass with none exercising kinds, languages, atoms, or files; a test saves a definition carrying the old fields and checks they are dropped, and another checks `node-reserved`; the built `lib/index.js` and `lib/client.js` contain no `atomFiles`, `code-block`, or `workflow.go`; demo-node, which never set `kinds`, needed only test fixture edits. Net about a thousand lines left the source.
