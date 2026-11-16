# Agent Note: Workflow IDs derived from names

Status: implemented

## Problem

The JSON storage backend writes each workflow to `workflows/<id>.json`. With random IDs the storage folder is unreadable, an exported file means nothing next to it, and a person looking for "the daily report workflow" has to open every file. A workflow already has a unique, human-chosen key: its name.

## Decision

A workflow's ID is its name reduced by `workflowSlug` (`src/shared/slug.ts`): lowercase, runs of characters outside `[a-z0-9]` become `-`, at most 64 characters, `workflow` when nothing is left. Names are unique but slugs are not, so `uniqueWorkflowSlug` appends `-2`, `-3` to a slug another workflow holds. The ID is also the record file name, so `Daily Report v2` is stored as `daily-report-v2.json`.

**Saving by name reuses the ID.** `save()` replaces the workflow of the same name in place.

**Renaming moves the record only when the ID changes.** `update()` derives the ID the new name would get, treating the workflow's own ID as free. If that is the current ID, as when only case or punctuation changed, the record is rewritten where it is. Otherwise the new record is written before the old one is deleted, so an interrupted rename leaves a duplicate rather than losing the definition, and the caller must use the returned ID. A workflow saved under an older naming rule keeps its ID until it is renamed.

**A rename that changes the ID is refused while another workflow embeds it**, because a `subworkflow` node links by ID and would be left pointing at nothing. Deleting an embedded workflow is refused for the same reason.

**Importing never replaces.** An imported workflow whose name is taken is renamed `Name (2)`, because saving reuses the ID of a same-named workflow.

**Name lookup and writes go through one mutation queue**, so two concurrent saves of one name reuse one ID.

## Alternatives considered

**Random IDs with the name stored inside.** Renames become free and links never break, and the storage folder stops being readable, which is what this decision exists for.

**Retargeting embedding workflows on rename.** It would make renames of embedded workflows always succeed, at the cost of a rename rewriting other workflows in the same mutation, and of a run snapshot taken just before the rename resolving to a different set of records. Refusing is simpler and tells the author what to change.

**Always moving the record on rename.** The first implementation did, so renaming `Add Offset` to `add offset` moved it to `add-offset-2` and, when it was embedded, refused a rename that broke nothing. Treating the workflow's own ID as free removes both.

## Consequences

Renaming a workflow can change its ID, so every caller of `update()` reads the ID it returns, and the panel reselects it. Two names that slug alike get suffixed IDs that depend on save order. Non-ASCII names all slug to `workflow`, so their files are told apart only by suffix.
