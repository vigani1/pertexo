# ADR064 — Shared workflow organization and private favorites

Status: **ACCEPTED — primary exact-source review of `a0508cd0`, 2026-10-02.**
The primary accepted the qualified F06 handoff at `eed68cd6` on 2026-10-02.
Release-owner reconciliation and primary authorization allocate migration 0134
exclusively to F07 against exact qualified integration base `936612f2`, whose
tree is identical to accepted F06 `eed68cd6`. Persistent continuation is now
authorized, not writer enablement or completed behavior.
Number reserved by the primary on 2026-10-02. Parent: [F07](../feature-plans/07-workflow-organization.md).

Workflow discovery currently paginates saved workflow summaries but searches and
filters lifecycle only over loaded browser pages. We propose shared workspace
tags and later folders, plus strictly private per-person favorites, behind the
existing workflow-authoring list/command interface. PostgreSQL remains durable
authority; organization neither changes workflow permissions nor executable
graphs, portable exports, activation, publication or historical template origin.

Use workspace-scoped tag identities with bounded lowercase ASCII kebab-case keys
(explicit U+0020 trim and ASCII lowercase), 16 tags/workflow and 256 live tags/
workspace. Owners/admins manage vocabulary; workflow editors assign it. Stable IDs
survive rename; deletion removes assignments and advances each affected workflow's
independent organization revision. Inspect at most 51 assignments under the
common lock: ≤50 are atomically detached with revision bumps and tag deletion;
overflow conflicts with zero change. Owner/admin has bounded assignment discovery
including archived workflows and explicit ≤50-item cleanup detachment, then
fresh confirmed deletion. Cleanup does not require restoring archived workflows.
No tag-degree quota, unbounded mutation, worker or tag-tombstone job is added.

Favorites belong to authenticated actors, including viewers, and never appear in
another member's projection/audit. Use desired-state commands with independent
opaque revision tokens and one false-state tombstone per person/workflow for the
existing 24-hour retry horizon, not toggles or unbounded per-toggle history.
Absence is an authenticated server-issued `absent.v1` read token, not the timeless
literal `absent`. On 2026-10-02 the primary accepted this correction before the
favorite helper: a never-delivered pre-departure command has no receipt to fence
it, and the literal would repeat after rejoin. The bounded 24-hour token binds
workspace/person/workflow/private membership generation through a domain-separated
HMAC using the existing dedicated organization secret; generation is not in the
wire. After authenticated transport verification, SQL independently rechecks the
locked generation, current absence, authority and database-clock expiry. Exact
same-generation committed receipt replay precedes token expiry/rotation checks;
neither old-generation replay nor a never-recorded old request can restore state.
Permanent departure invalidates private state; held evidence follows existing
legal-hold/deletion orchestration and cannot become rejoined-member state.
Suspension only denies access. Shared metadata survives its author's departure.

Use opt-in strict metadata projections and server-side literal, case-sensitive
name/tag/lifecycle/favorite filters before existing bounded keyset pagination.
New cursors are signed opaque versioned scoped/filter-bound continuations, never
authorization. Existing default responses/cursors remain unchanged. Organization
and private favorite writes do not reshuffle workflow.updated_at or borrow
name/lifecycle/graph revisions. Exact receipt replay precedes current selection/
writer checks after current authority/visibility, retaining old command identity.

Primary accepted the slice-1 HTTP routes and separate UUID-page cursor on
2026-10-02 before endpoint implementation. Workspace tag vocabulary uses
GET/POST `workflow-tags`; rename/delete, workflow tag replacement and favorite
desired-state changes use POST commands. Owner/admin assignment discovery uses
GET `workflow-tags/:tagId/workflows`; explicit cleanup uses POST
`workflow-tags/cleanup/detach`. Vocabulary and assignment discovery paginate by
ascending UUID with no total count. Their purpose-bound cursor derives a separate
HMAC subkey from the existing dedicated organization root, not a new secret or
an overloaded timestamp workflow cursor. The accepted exact transport and wire
constraints are recorded in the contract below.

Shared metadata/archive/hierarchy mutations obey one workspace-first lock order
and dedicated organization-coordination lock before tag/folder/workflow locks.
Folders remain required follow-on scope: one folder/workflow, depth ≤4, 256 folders/
workspace, tenant-aware parents, serialized cycle/depth checks, stale revisions
and refusal of nonempty deletion. Bulk follows with explicit ≤50 workflow IDs,
independent per-item transactions, current authority on processing/replay, private
not-visible outcomes and frozen exact retry identity; partial completion is shown.

Alternatives considered: Unicode-equivalent tag labels introduce normalization/
collation obligations; builder-managed vocabulary allows wider shared mutation;
last-write-wins favorites permit delayed overwrites; client-only filtering misses
unloaded matches; unconditional summary fields break strict clients; folder ACL
inheritance creates an unrequested permission model; atomic whole-batch mutation
lets one stale item block every valid item. The narrower proposal avoids these
costs while leaving explicit future choices, not silently inventing them.

Additive child relations, RLS/least privileges, hold-aware bounded purge, independent
reader/writer rollout and exact readiness cutover precede enablement. Rollback
disables controls/new writes but retains compatible readers and metadata. No
down migration, external search cluster, new package, provider effect, production
operation follows from this ADR. The
[contract proposal](../feature-plans/07-organization-contract-proposal.md) carries
concrete normalization, privacy, locking, recovery and acceptance requirements;
govern implementation. Folder name bounds/sibling uniqueness and exact folder
command schemas require a reviewed follow-on before the folder slice. Primary
full-source review on 2026-10-02 accepts the folder policies and concrete routes in
[the follow-on](../feature-plans/07-folders-bulk-follow-on-proposal.md): U+0020-trimmed
display names bounded to 128 UTF-8 bytes without C0/DEL, ASCII-only lowercase
sibling identity under PostgreSQL `COLLATE "C"` including root siblings, stable
folder revisions, exact root/UUID filters, and owner/admin archived placement for
explicit cleanup. A subsequent full-source review accepts general-bulk whole-parent
idempotency through the existing scoped receipt owner: constant shared batch
operation, full canonical parent-body hash, admitted-only marker committed before
independent item transactions, and matching committed admission verified by each
NEW item helper. Item receipts alone cannot bind a disjoint changed request;
parent admission never promises atomic completion. Release-owner global allocation
and exact integration-base audit reserve additive migration 0135 exclusively for
this follow-on; the qualified 0134 migration and inventory remain immutable.
