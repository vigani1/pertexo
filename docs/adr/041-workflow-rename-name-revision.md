# ADR 041: Workflow rename with an independent name revision

- **Status:** accepted
- **Date:** 2026-09-25
- **Requested by:** the product owner
- **Related:** ADR 011 (draft concurrency), ADR 033 (summary projection) and
  ADR 034 (lifecycle commands)

## Context

A workflow's display name is set once at creation and could not be changed.
The workflow summary that every client reads exposes two concurrency tokens
today: the ADR 034 `lifecycleRevision`, which advances once per effective
archive or restore, and, through the separate draft read, the ADR 011 draft
revision behind the opaque draft ETag. A rename needs a precondition so that
two people renaming the same workflow cannot silently overwrite each other.

Reusing either existing token would couple unrelated edits:

- Advancing `lifecycleRevision` on a rename would make an archive or restore
  prepared before the rename fail with a lifecycle conflict, and ADR 034
  defines that revision as advancing only on effective lifecycle transitions.
- The draft revision and ETag belong to the editable graph. Advancing them on a
  rename would make an open editor's autosave fail with `412` and ask people to
  reconcile a graph nobody changed. The name is not part of the graph, its
  checksum or any published version.

## Decision

The name gets its own revision. `app.workflows.name_revision` is a positive
integer that starts at one and advances once per effective rename. It is
independent of the lifecycle revision, the draft revision, publication and
activation convergence. Every workflow summary exposes it as `nameRevision`,
so the list, the metadata read and every command response carry the current
precondition.

`POST /v1/workspaces/:workspaceId/workflows/:workflowId/rename` mirrors the
ADR 034 command shape. It requires an authenticated session, CSRF, exactly one
`Idempotency-Key` and the strict body `{ name, expectedNameRevision }`, where
the name uses the existing workflow-name contract (trimmed, 1–128
characters). Renaming is an edit, so it requires `workflow:update` in an
active workspace — the same authority as draft saves and version restoration
— and not publication authority.

One transaction checks current membership and workspace state, claims an
actor-, workspace-, workflow- and operation-scoped key in the existing
idempotency records, locks the workflow, checks the name revision, updates the
name and revision and appends one `workflow.renamed` audit fact with the
previous and new name and revision. A stale revision returns the typed `409`
problem `workflow.name_conflict` with `currentNameRevision` and changes
nothing. The same name at the current revision is a no-op: no revision, audit
fact or timestamp change. An exact retry returns the original accepted
summary before any revision check; the same key with another body is
`request.idempotency_conflict`. Results expire with the existing idempotency
retention. The route answers `200` with `{ workflow, replayed }` because the
change is complete when the response is sent; there is no activation work to
converge, unlike archive and restore.

An archived workflow is read-only, like its draft and version restoration:
the rename returns the existing non-disclosing `404` until the workflow is
restored. Missing and cross-tenant workflows use the same response. Renaming
never touches drafts, published versions, triggers, activation or runs. Runs
keep resolving the immutable version they were accepted with; reads that show
a workflow's name show its current name, as run history already does.

Command receipts written by archive and restore before this change carry no
name revision. Every workflow still had its initial name revision then, so a
replayed receipt without the field reports `nameRevision: 1`; stored receipts
are never rewritten.

## Consequences

People can rename a workflow from the workflow hub, the workflow list and its
settings, and a concurrent rename is reported instead of lost. A rename never
disturbs an open editor or a pending archive or restore, and neither of those
disturbs a rename. The summary grows one required field, so this unreleased
client and API deploy together, as with the earlier summary additions.

The trade-off is a third revision on the workflow aggregate. It is cheap —
one integer column and one guarded update — and keeps each revision's meaning
narrow. The conflict problem carries only the revision; clients read the
workflow again to show the name someone else chose, following ADR 011's
“synchronization hint, not a merge base” rule.

## Rejected alternatives

- Advancing `lifecycleRevision` on a rename, which would create false
  lifecycle conflicts and change ADR 034's definition.
- Guarding the rename with the draft ETag, which would break autosave for an
  unrelated change and put metadata into the graph's concurrency model.
- `PATCH /workflows/:workflowId`, which would introduce a second general
  update verb for one field instead of the POST-to-verb command convention the
  workflow resource already uses.
- Last-write-wins renames without a precondition.
