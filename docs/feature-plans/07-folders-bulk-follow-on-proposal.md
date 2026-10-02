# F07 folder and general-bulk follow-on

Status: proposed for primary review, not accepted implementation guidance.
Builds on [ADR064](../adr/064-workflow-organization-metadata.md) and the accepted
[organization contract](07-organization-contract-proposal.md). No folder SQL or
runtime code precedes acceptance. Migration 0134 remains unchanged; a subsequent
migration number must be allocated against the then-current integration head.

## Folder identity, names and hierarchy

A folder is workspace-owned organization, never authorization. One workflow has
zero or one folder; `null` means unfiled, not a stored root folder. A top-level
folder has `parentId: null` and depth 1. Four folder levels and 256 live folders per
workspace remain hard bounds, including descendants. UUID identity survives
rename and move. Deleting any folder with an immediate child or any assigned
workflow, including archived workflows, conflicts without mutation; no recursive
delete, implicit unfiling or hidden cleanup job.

Proposed names: explicitly trim only U+0020; retain display casing; require 1–128
UTF-8 bytes; reject C0 controls and DEL. Derive sibling identity by ASCII-only
`A`–`Z` lowercase after that trim. Compare the identity with PostgreSQL `COLLATE
"C"`; do not normalize, transliterate or Unicode-case-fold. Thus `Ops` and `ops`
conflict among siblings, but `Équipe` and `équipe` do not. The stored canonical
identity is internal, not a second user-editable field. Root siblings obey the
same uniqueness rule using `(workspace_id,parent_id,name_key)` with `NULLS NOT
DISTINCT`. Parent and workflow placement references use composite workspace/ID
foreign keys; no cross-workspace parent, placement or move can succeed.

Each folder has positive safe-integer `revision`, initially 1. Every new rename
or hierarchy-move command, including a no-op, advances it once; exact replay does
not. Renaming/moving a folder does not rewrite descendants, workflow organization
revisions or workflow timestamps. Descendant depth/path is derived from current
bounded hierarchy. Moving a subtree checks its deepest descendant plus the new
parent depth, not only the selected folder. Self/descendant moves conflict.

## Routes, roles and command shapes

Routes are relative to `/v1/workspaces/:workspaceId`, with existing session,
workspace selection, CSRF on POST, idempotency, cancellation and no-store rules.
All active members may read. Folder create/rename/hierarchy move/delete require
owner/admin, without broadening the existing `workspace:manage` capability.

- GET `/workflow-folders`: `{items:[{id,name,parentId,revision,depth}]}`, ascending
  UUID, at most 256, no total count or recursive workflow inventory.
- POST `/workflow-folders`: `{name,parentId:UUID|null}`; returns `{folder,replayed}`.
- POST `/workflow-folders/:folderId/rename`: `{name,expectedFolderRevision}`;
  returns `{folder,replayed}`.
- POST `/workflow-folders/:folderId/move`: `{parentId:UUID|null,expectedFolderRevision}`;
  returns `{folder,replayed}`. Destination identity is stable; check current
  destination existence and hierarchy, not its historical display name/revision.
- POST `/workflow-folders/:folderId/delete`: `{expectedFolderRevision}`;
  returns `{folderId,deleted:true,replayed}` only if empty.
- POST `/workflows/:workflowId/folder`: `{folderId:UUID|null,expectedOrganizationRevision}`;
  returns `{workflowId,folderId,organizationRevision,replayed}`.

Workflow placement uses the existing organization revision, not a new workflow
folder revision. Every new placement no-op bumps once; replay never bumps.
Owner/admin/builder can place active workflows. For archived workflows, only
owner/admin may place/unfile, allowing explicit archived cleanup before empty
folder deletion without enabling graph edits or general archived tag replacement.
Each item still checks current lifecycle and role under the shared lock.

GET organization metadata keeps its existing shape but `folderId` becomes nullable
UUID. Without `include=organization`, legacy representations stay unchanged.
Workflow list `folderId=UUID` selects that exact folder only, never descendants;
`folderId=root` selects unfiled workflows; omitted means all folders/unfiled.
Intersect with current tag/favorite/lifecycle/literal-search predicates before
pagination. Bind canonical root/UUID/no-filter separately into signed filter hash.
Unknown/foreign folder filters are scoped empty, while missing/foreign folder
administration is generic 404. Hierarchy navigation derives paths from the bounded
folder response, not authorization or unbounded recursive discovery.

## General bulk and recovery

POST `/workflows/organization/bulk` accepts exactly one discriminated operation:
`{operation:'move',folderId:UUID|null,items}` or
`{operation:'replace_tags',tagIds:[UUID...],items}`. Each `items` entry is exactly
`{workflowId,expectedOrganizationRevision}`; ordered 1–50 unique workflow IDs.
Tag IDs remain sorted/unique and at most 16. There is no select-all, saved query,
wildcard, mixed operation or actor field. Static route collision is HTTP-tested.

Use independent sequential transactions in submitted order. Derive each item's
receipt key from a domain-separated hash of parent key, operation and workflow ID;
the normalized per-item command body retains target/revision. Retry the frozen
entire request, not regenerated revisions/keys. Completed known items replay;
unprocessed items can execute only with current authority. The parent has no
atomic receipt pretending that partial work is all-or-nothing.

Ordered outcomes reuse the reviewed cleanup vocabulary, with success
`{workflowId,status:'updated',organizationRevision,replayed}`. `not_visible`
does not disclose missing versus foreign. `conflict` allows only organization
revision/idempotency/lifecycle and applicable folder-not-visible conflict;
`unavailable` is the existing organization 503; unexpected commit/transport
ambiguity is `outcome_unknown`. Current authority loss is `forbidden`, immediately
stops processing and marks remaining entries `not_processed`, exposing no retained
receipt/revision. Reread informs current UI; historical replay is never installed
as the current projection. Only known outcomes plus explicit fresh confirmation
permit a new command; abort/unknown retains the original retry identity.

## Persistence, locks and rollout

Use the existing scoped shared receipt owner and organization writer gate. Lock
workspace admission, actor/member, receipt, organization coordination, folder
UUIDs, tag UUIDs when needed, then workflow UUIDs. Existing operations without
folders keep their relative order. Hierarchy mutations take coordination exclusive
before traversal and locks; bounded hierarchy checks cannot race with another
move/create/delete. Placement/tag replacement/deletion keep their serialized
organization coordination semantics. Replay checks current authority/visibility
before returning historical receipt, and bypasses only new-command writer/CAS
policy. There is no implicit privilege inheritance or folder read grant expansion.

Add folder vocabulary and nullable organization placement to forced-RLS/catalog
readiness, bounded purge and retention ownership; preserving existing 0134 helper
ABI/body checks is part of the cutover plan, not permission to weaken readiness.
No migration edits, writer enablement or deploy until exact upgrade/old-image
denial/compatible-OFF readers and hold-safe bounded cleanup are qualified. Import,
export, duplicate and template origin do not copy folder/organization metadata.

Before code, review the proposed name/control policy, archived admin placement,
bounded hierarchy response, bulk target semantics and new sanitized conflict
codes: `workflow.folder_name_conflict`, `workflow.folder_limit_exceeded`,
`workflow.folder_revision_conflict`, `workflow.folder_hierarchy_conflict`,
`workflow.folder_not_empty`, `workflow.folder_not_visible`. Acceptance also needs
race tests for sibling uniqueness, cycles/subtree depth, stale rename/move versus
archive, partial recovery/authority loss, restart and actual accessible browser
navigation retaining exact filters and selection.
