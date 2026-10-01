# ADR 060: Independent workflow copies preserve graph-local identity

- **Status:** accepted
- **Date:** 2026-10-01

## Decision and scope

The user approved a new workflow identity with preserved internal node and edge
IDs for F05's same-workspace Duplicate workflow slice. A copy is an independent,
unpublished workflow with a revision-1 draft, not another view of the source.
This supersedes F05's original requirement to remap every graph identity when
copying an entire workflow. It does not change duplication of nodes within one
workflow, where originals and copies coexist and fresh IDs remain necessary.

Graph-local IDs are interpreted in their owning workflow and, during execution,
the particular run/version/invocation scope. No cache, query, mutation or runtime
lookup may identify a persisted node using its graph-local ID alone. Prove this
isolation through the real implementation before closing the slice.

## Why

Pertexo's existing expression context exposes `nodeOutputs` keyed by node ID.
Policy-v1 accepts `$lookup(nodeOutputs, runInput.stepId).value`: it can select a
node using a value known only at execution time. Regenerating IDs breaks that
expression even if every typed `node_output` mapping and edge is rewritten.
String replacement is not a safe expression rewrite; runtime aliases or a new
expression reference model would broaden this small authoring feature.

Preserve the complete selected graph as JSON value content: recursive node/edge
IDs, typed mappings, expressions, merge/parallel references, body port names,
configuration, positions, labels, disabled flags and graph settings. Do not
rewrite strings or generate a second remapper for whole-workflow copies. New
workflow identity keeps persistence and execution independent. Publication and
its workflow-local checksum identity remain governed by ADR002.

## Source and admission

Offer the saved current draft or an explicitly chosen retained immutable version
of an active workflow in the same active workspace. Never copy unsaved browser
state implicitly. The server reads the source; the request does not carry a
graph, destination workspace, destination identity or credentials.

Draft copies require the existing single strong draft `If-Match`, including its
selected compatibility fingerprint, checked in the authoritative transaction.
Missing/malformed/stale tags follow ADR011 (428/400/412). A version copy names
the exact version ID, resolved by workspace/workflow/version together; it does
not silently substitute the latest version or use a draft tag for that version.

Apply current bounded draft parsing and definition placement against an empty
destination, not the source graph's grandfathered placement. Unknown or
non-placeable definitions cannot enter a new workflow through copying. Preserve
the normal distinction between editable drafts and publishable graphs: copying
is not publication, config migration, expression evaluation or execution.
Other publish-blocking draft issues remain visible through existing validation.
Never relax graph limits or silently drop unsupported content.

Retain same-workspace connection references, not credential bytes. Verify their
workspace ownership without disclosing foreign resources; a forged cross-tenant
reference rejects the command. Unhealthy/revoked same-workspace connections do
not become healthy through copying; keep existing repair/validation behavior.
Do not dereference secrets or claim that arbitrary user-authored literal text
has been automatically scrubbed. Cross-workspace export/import is a later,
separately designed feature.

## Atomic command and recovery

Use one authoring operation, proposed route
`POST /v1/workspaces/:workspaceId/workflows/:workflowId/duplicate`, with a strict
body containing a bounded destination `name` and a discriminated `source`:
`{ kind: 'draft' }` or `{ kind: 'version', versionId }`. Require session/CSRF,
source read authority and destination `workflow:create` authority. Recheck active
actor/membership/workspace authority in the transaction under existing locks/RLS;
an ID, tag or command key is never authority.

Require the existing bounded `Idempotency-Key`. Scope receipts by workspace,
actor, source workflow and the distinct `workflow.duplicate` operation. Bind the
canonical request hash to that scope, normalized name, exact source selector
and original draft tag (when applicable). Do not hash a later reread of mutable
source content as if it were the original request.

Serialize concurrent same-key requests with the durable receipt claim. After
current authorization/visibility checks, an exact completed receipt returns its
original destination identity before comparing current source revision/catalog.
Changed input with the same key conflicts. A new command checks active source,
source identity/tag, catalog placement and connection ownership before creating
anything. Lock source workflow before draft, consistent with existing authoring
order; keep authority/catalog/source selection and destination creation atomic.

Commit the new workflow, exactly one revision-1 draft, safe audit metadata and
completed receipt together. Generate the destination identity on the server.
Prefer the existing atomic creation foundation, but do not conflate its
`workflow.create` receipt with a source-scoped duplicate receipt or call a public
create method in a second transaction. A focused additive database function is
appropriate if required by existing grants; prove least privilege, readiness,
mixed-version compatibility and rollback before enablement.

Return a strict identifier-only result (`workflowId`) with HTTP 201 and the
destination Location; an exact replay returns the same result without copying
again. The UI loads the normal authorized destination representation separately.
Do not store graphs, raw keys/tags, expressions or credentials in receipt/audit
metadata. Current source/destination visibility must be checked on replay;
archiving must not cause a second copy, and missing/retained-away resources must
fail closed rather than recreate them. Reuse the existing finite command-receipt
retention and membership/workspace erasure policy; after receipt expiry this is
not a forever-deduplication guarantee. Verify cleanup of source-scoped receipts
whose resource identity points to the destination.

The destination has normal fresh-workflow operational defaults: no publication,
activation, run history, trigger registrations/cursors, pauses/failure streaks,
concurrency overrides/reservations, notification settings or health observations
copied from the source. Graph settings are graph content and remain preserved.
No trigger reconciliation outbox event, provider request, secret duplication or
production admission is emitted by duplication. Publish and run remain explicit.

## Interface ownership and verification

Extend existing workflow-authoring contracts, use cases and persistence through
one `duplicateWorkflow` operation. Keep transaction authority in its persistence
implementation and browser command recovery in the existing workflow feature.
Do not introduce a portability framework, expression alias registry, generic
copy service or new package for this slice.

Required evidence includes real concurrent same-key execution, distinct-key
copies, rollback at each write, draft-save/archive/membership/catalog races,
restart/lost-response recovery, exact graph equality including dynamic JSONata,
and independent editing/execution of two workflows sharing graph-local IDs.
Show no cross-workspace disclosure or unwanted operational state copying.
Exercise authenticated browser-to-API-to-database duplication, enabled in owned
local/CI fixtures with strict reports. Production activation remains unauthorized.
