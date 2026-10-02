# F07 — Workflow organization contract proposal

Status: **ACCEPTED CONTRACT — primary exact-source review of `a0508cd0`, 2026-10-02.**
The qualified F06 handoff at `eed68cd6` is accepted by primary final source review.
Persistent implementation is authorized on the release-owner exact integration
base and allocation recorded below. No writer enablement or completed behavior
is implied.
Inventory source: `1433780b8540545bea66ba9f39aff9e44f40e3c3`, 2026-10-02.
Parent: [F07](07-workflow-organization.md), [roadmap](../product-roadmap.md).
This inventory was read-only preparation before the F06 handoff, not runtime proof.
At that preparation checkpoint F06 qualification was the active priority. F07
contracts/model/frontend preparation is now authorized. The primary reserved
ADR064; its [decision](../adr/064-workflow-organization-metadata.md) is accepted.
Release-owner reconciliation now allocates migration 0134 exclusively to F07
against exact locally qualified integration base
`936612f26567f760c83e41c13e4c7fc7b620e69f`, tree
`45445a2deb287e7534f69b536e4415939a2ca204` (identical to accepted F06 `eed68cd6`).
The primary authorized persistent continuation on that base; writers remain off
until owned qualification. Historical F06 results retain their original source
bindings, not relabeled as reruns on the integration merge.

## Current canonical owners

| Responsibility | Current source | Reuse / gap |
| --- | --- | --- |
| Workflow HTTP transport and authorization | `apps/api/src/workflow-authoring/controllers.ts`, `guards.ts`, `use-cases.ts`, `ports.ts` | Existing workflow-read/update capabilities and scoped persistence; no organization transport found in targeted inventory. |
| Public strict schemas and generated HTTP contract | `packages/contracts/src/http/workflow-authoring.ts`, `packages/contracts/src/workflow-authoring.ts` | Workflow summary is strict. List currently accepts only limit, after and order. Default schemas must not gain unconditional metadata fields. |
| Durable metadata / list reads | `packages/database/src/authoring/workflow-authoring-reads.ts`, `workflow-authoring-contracts.ts`, `workflow-authoring.ts`, `schema/authoring.ts` | List checks current reader authority, bounds limit to 100 and keysets on timestamp+UUID. Reuse this owner, not a second search store. |
| Strong revision commands | Workflow rename/lifecycle owners under `packages/database/src/authoring`, API rename/lifecycle use cases | Existing independent name/lifecycle revisions, idempotency and stale-write handling are precedents; organization must not repurpose graph/name/lifecycle revisions. |
| Tenant / membership policy | `packages/database/src/tenant-access/workspace-policy.ts`, `identity-workspace-membership-lifecycle.ts` | Active actor/workspace/membership checks; removed membership rows remain for departure replay. Metadata must not introduce access inheritance. |
| Retention / deletion | Existing lifecycle/purge migrations and `packages/database/src/lifecycle` | Workflow/workspace deletion, legal holds and bounded tenant purge remain authoritative. New rows need cascade or explicit bounded purge inclusion, not a new TTL. |
| Browser list, HTTP and remote state | `apps/web/src/features/workflows/workflow-list-page.tsx`, `workflows.api.ts`, `workflows.queries.ts`, `model/workflow-list-view.ts` | Query keys already include user+workspace. Name/lifecycle filtering currently covers loaded pages only; not authoritative server search. |
| Browser navigation state | `apps/web/src/routes/workflow-list-route.tsx`, workflows list model | URL currently retains lifecycle view/sort/create, not name query. Add bounded organization/search state here. |
| Existing unrelated flags | `model/template-feature-gates.ts` and SQL portability/template rollout gates | F06 chooser/presentation flags remain off. Do not reuse them for F07. No F07 flag or complete tags/folders/favorites product found in targeted inventory. |

Existing workflow graph, publication, activation, archive/restore, input cases,
portable V1/export and historical template origin remain separate domains.
Organization is mutable metadata, not executable semantics or workflow access.

## Accepted delivery scope

1. Tags and private favorites, with authoritative bounded list filters and a
   useful browser list/row interaction. Include the limited owner/admin assignment
   discovery and explicit bounded detach needed for overflow deletion recovery;
   do not leave a visible delete action without its supported recovery. No enabled
   placeholders.
2. Folder navigation, individual moves and folder administration after its
   hierarchy/race model is accepted. Folder placement never changes permissions.
3. Explicit bounded bulk tagging/moving, with per-item outcomes and stale-write
   conflicts. Do not omit these from F07, or claim them complete with slice 1.

Do not create a package, worker job or external search service. Keep durable
transactions/projections in database authoring, transport in API authoring,
browser-safe schemas in contracts, and UI/Query/Router state in web workflows.

## Accepted slice-1 semantics

### Shared tags

Recommendation: workspace-scoped stable tag IDs and unique canonical keys;
workflow assignments reference tag IDs, not duplicated labels. Initially use
lowercase ASCII kebab-case keys, 1–32 bytes, at most 16 tags/workflow and 256
live tags/workspace. Accept uppercase ASCII input only through an explicitly
specified lowercase normalization, trim only U+0020 outer spaces, reject any remaining
invalid characters; never silently transliterate Unicode. Return the canonical
key before confirmation. Bounds are server-enforced, not caller-configurable.

Exact algorithm: remove leading/trailing U+0020; map ASCII A–Z to a–z; require
`^[a-z0-9]+(-[a-z0-9]+)*$` and 1–32 UTF-8 bytes. No Unicode case fold, tab/newline
trim, normalization or transliteration. `  Ops-2  ` becomes `ops-2`; `ops_2`,
`-ops`, `ops--2`, `équipe` and tab-wrapped input fail. Duplicate canonical keys
conflict workspace-locally; normalized command bytes, not original spelling,
determine idempotency identity. SQL checks canonical ASCII with C collation.

Trade-off: ASCII keys make normalization/uniqueness portable and auditable but
restrict international labels. Alternative: Unicode display labels with a
separate pinned canonical-key algorithm and documented equivalence/collation;
requires cross-tier vectors and an explicit primary decision before code.
Do not conflate workflow-name search behavior with tag normalization.

Any active member with `workflow:read` can read tags. Assignments require
`workflow:update` on an active workflow; proposed vocabulary creation/rename/
deletion is owner/admin-only through existing workspace authority. Alternative:
builders manage the shared vocabulary, which is simpler inline UX but allows
team-wide edits; the primary must choose this permission, not infer it.

Delete a tag by an explicit owner/admin command that removes its
assignments, without deleting/changing workflow graph/name/lifecycle. Lock the tag row to fence
assignment races. Tag IDs are never reused; later recreation has a new ID.
Rename preserves ID and assignments, rejects canonical-key collision, and uses
its own expected revision. No hidden tag merges. Archived workflows retain tags;
archive/restore never rewrites assignments. Global deletion affects archived
assignments too and must say so in confirmation.

Every removed assignment advances that workflow's organization revision exactly
once, including archived workflows, in the same transaction as its removal.
Tag rename preserves organization revisions because assignments reference stable
IDs; tag vocabulary revision advances instead. Primary clarified bounded deletion:
under the common organization/tag lock inspect assignments with `LIMIT 51`.
At most 50 affected workflows are locked in UUID order, each assignment is removed
and each organization revision advances once, then the tag is deleted atomically.
Finding a 51st assignment returns a sanitized too-many-assignments conflict with
zero deletion/assignment/revision changes. Never lock every matching workflow
before this bounded preflight; do not hold locks during human confirmation.

For overflow, owner/admin uses bounded authoritative assignment discovery with
keyset pages, including archived workflows; this is scoped admin cleanup, not a
public workflow/tag fan-out count. Explicitly selected ≤50 IDs can be detached in
bulk with each expected organization revision, then a fresh confirmed delete is
submitted after reread. Admin cleanup deliberately permits archived targets:
ordinary editor tag replacement remains active-only, but cleanup must not require
restoring archived workflows or leave undeletable tags. No implicit “detach all,”
tag-degree quota, worker job or tombstoned-tag cleanup protocol is added. Keep each
bulk item's current authority/replay/visibility checks and revision outcomes.
The delete command is frozen during recovery; after cleanup changes the intended
operation, use a fresh confirmed command/key, not the finalized old identity.
Failed/uncertain attempts retain the existing receipt and exact-retry policy.

Workflow tag-set replacement is bounded and revision-checked. Use one independent
organization revision and an exact normalized command identity; concurrent
changes from the same revision yield one winner and a stale conflict, never a
silent lost update. Replaying a committed identical command returns its recorded
outcome after current authority; same key/different command conflicts. Name,
graph and lifecycle revisions are independent. The shared lock order below
governs tag replacement/deletion, archive and hierarchy changes.

### Private favorites

Favorite means a person's bookmark of a visible workflow in one workspace.
It is not a workspace recommendation, permission, activation state or shared
workflow property. Key it by `(workspace_id, user_id, workflow_id)` with composite
workflow FK and actor-scoped RLS. Actor identity comes only from authenticated
context: no API userId selector, member favorite count/list or administrator
cross-person favorite access. Members with workflow-read may favorite, including
viewers. Archived workflows retain bookmarks and can be found through archived
filters; favorites never bypass ordinary visibility.

Prefer explicit desired-state `favorite: true|false`, not toggle. An independent
per-person/per-workflow revision (including an absent-state/tombstone protocol)
prevents delayed retries from overwriting a later opposite action. Reuse exact
idempotent command recovery; do not implement delete-and-retry-as-a-new-command.
Alternative last-commit-wins desired state is smaller but surprising across tabs
and outcome-unknown recovery; accept that weaker semantics explicitly if chosen.
Do not increment shared organization revision or workflow.updated_at for a
personal bookmark, and do not emit tag/favorite literals in telemetry.

Proposed concrete token: `favoriteRevision` is `absent` when no current state
exists, otherwise an opaque server-generated UUID refreshed on every committed
favorite command. A false state is a tombstone, not immediate physical deletion.
It persists through the existing 24-hour terminal-command retry horizon; matching
receipt replay precedes revision checks and does not renew its expiry. Keep at
most one state/tombstone per actor/workflow, never one row per toggle; reap expired
false rows in existing bounded maintenance batches, respecting holds. After
expiry a new command requires a current read, not automatic retry/reset; the
contract does not promise deduplication or stale-token fencing beyond that horizon.
The concrete migration must prove cleanup indexing and API-rate-limit composition;
time-bounded retention alone is not a claim of a hard row-count quota.

Suspension denies access immediately but preserves bookmarks for reactivation.
Recommendation: permanent membership removal invalidates that membership's private
favorites atomically; rejoining starts without old private state. Physical deletion
obeys existing legal-hold/deletion orchestration. Held rows are inaccessible
retained evidence, explicitly not bookmarks restored by a later rejoin; use a
membership generation/tombstone fence, not user/workspace identity alone. User deletion
and actual workflow/workspace purge also remove them, respecting existing holds
and deletion orchestration. Alternative retaining favorites after removal needs
explicit retention/rejoin disclosure and bounded purge rules. RLS alone is not
deletion handling. Shared tags/folders are not removed when their author leaves.

## Discovery, projection and pagination

Extend the existing list/search owner with filters applied in SQL **before**
keyset pagination: bounded name query (proposed 128 UTF-8 bytes), lifecycle
active/archived/all, one tag ID and favorites-only initially. Filters intersect;
favorites always use current actor. Later folder filter must distinguish exact
folder from descendants; recommend exact folder only in V1. Unknown/deleted tag
or folder filters return an empty scoped result, not cross-tenant existence detail.
Escape SQL wildcard metacharacters so name search is a literal substring.
Proposed exact name-search semantics are case-sensitive PostgreSQL `LIKE` with
explicit C collation and escaped `%`, `_` and escape character, no Unicode fold
or normalization. The browser sends the exact bounded query (no locale-lowercase
postfilter); a case-insensitive Unicode search would require a separate accepted
algorithm. Trim only outer U+0020 and omit empty query from canonical filters.
No exact global counters or total-results claim unless separately implemented.

Preserve default list order, page limits and old response shapes. Add an explicit
organization projection, not tags/favorites columns on `app.workflows` (strict
row readers currently select `*`). A projected list can return bounded
`{workflow, organization}` items with tags/revision and `isFavorite`/personal
revision, fetched in a bounded statement/batch rather than per-row reads.
Existing F06 `include=templateOrigin` remains independently available; any
combined GET include grammar needs exact contracts rather than an arbitrary
field-name list. Default and unsupported-reader responses never imply fabricated
empty metadata. Prefer a sanitized unavailable error to pretending no tags exist.

Proposed strict query addition: list `include=organization`; GET accepts exactly
`include=organization`, existing `include=templateOrigin`, or canonical
`include=templateOrigin,organization`. List metadata has `tags` (ID/key/tag revision),
`organizationRevision`, `folderId` (null in slice 1), `isFavorite`, and opaque
`favoriteRevision`. No user identity or other person's favorite data is returned.
Absent metadata is server-established default revision, not unsupported storage.

Cursor binds version, workspace, actor, order and canonical filter identity plus
timestamp/UUID position; reject changed-filter cursor reuse. Existing unfiltered
cursor semantics remain accepted on the old path. Query keys include the same
normalized filters/projection under existing user/workspace cancellation prefix.
Changing filters resets pagination and preserves URL state through navigation.
Keyset pagination is live, not a snapshot: concurrent workflow edits may move
items; clients deduplicate IDs and refresh explicitly, with no completeness
claim from loaded-page counts. Prefer existing ordering timestamps unchanged by
tag/favorite-only writes, so discovery actions do not reshuffle recent workflows.

New filtered/projected cursors are opaque bounded versioned base64url payloads
with a server HMAC over exact canonical payload bytes; reject signature/version/
scope/filter mismatches before database work with generic invalid-cursor detail.
Signing is integrity, not authorization or encryption: current membership and
workflow visibility are checked on every page. Do not place names/query literals
or favorite identities in logs. Key rotation may invalidate cursors and require
a fresh first page; no cursor permits skipping authority. Old unfiltered cursors
remain only on the unchanged unfiltered/default response path.

## Shared transaction order and race outcomes

Use the existing workspace admission/lifecycle lock first, then active actor and
membership authority locks, then the scoped command receipt, then one workspace
organization-coordination row, then tag/folder rows in UUID order, then workflow
rows in UUID order, then assignment/personal-state rows. Shared organization
mutation takes the coordination row UPDATE; archive takes SHARE at that same
position before its workflow lock. Tag replace/delete, hierarchy mutation and
workflow folder move use the same order. Favoriting takes SHARE before workflow
visibility/state locks. No path locks workflow first and then coordination/tag.

The archive helper must be additively upgraded to this order; do not assume
existing lifecycle code already participates. Existing workspace purge retains
its workspace-first order and must be reconciled against these locks. Completed
receipt replay rechecks current authority and visible workflow, but skips current
tag/folder existence and writer policy; it must not acquire locks backward.
If archive wins, ordinary new shared metadata commands fail lifecycle conflict
(explicit owner/admin cleanup detachment remains allowed on archived targets); if
metadata wins, archive retains its committed assignments. Opposite hierarchy
moves serialize before recursive cycle/depth validation. Member removal winning
first denies processing/replay. Do not introduce automatic new-key retries for
serialization/deadlock/outcome-unknown failures.

## Folder and bulk follow-on decisions (not silently deferred from F07)

Folder is a workspace-owned organization container with stable identity, parent
and revision; root is no-folder, not another workspace. Recommend one folder per
workflow, depth at most 4 and bounded folder count (proposed 256/workspace).
Names are bounded display metadata, not authorization/path identity. Parent FK
is composite tenant-aware. Cross-workspace moves are invalid, and self/descendant
moves fail. A parent move that makes any descendant exceed depth fails too.

Serialize hierarchy changes using an existing-order workspace-local lock or
explicit hierarchy revision so concurrent opposite moves cannot both pass a
preflight cycle check. Compare expected folder/placement revisions under that
lock. Define lock order before SQL; no unlocked recursive-check-then-write.
Folder rename preserves children/workflow identities. Recommend refusing deletion
of a nonempty folder; alternative explicit reparent-to-root requires bounded
work, stale revisions and clear atomic outcomes, not silent recursive deletion.

Bulk commands use explicit workflow IDs (proposed maximum 50), never “all search
matches” or unloaded browser selection. Each item carries expected organization
revision. Recommend one bounded independent transaction per item with exact
overall operation/item identity, returning ordered success/conflict/not-visible
outcomes; UI shows partial completion and retries only retained exact unsettled
items. Alternative all-or-nothing is simpler recovery but makes one stale item
block an entire batch. Primary must accept atomicity/privacy/race semantics;
no blanket success result. Bulk archive should reuse archive semantics rather
than inventing organization-specific lifecycle behavior.

Each item independently checks current actor/membership/capability and workflow
visibility at processing **and replay** time, not only at batch admission. Only
visible authorized items can return revision conflict/current revision. Missing,
foreign-workspace and otherwise nonvisible targets share a sanitized not-visible
outcome; no lookup confirms cross-tenant existence. Membership loss stops remaining
items with generic forbidden results and never exposes a retained receipt for an
inaccessible workflow. Item keys are deterministic opaque derivations of the
frozen overall command and item identity; retain frozen bytes through uncertain
recovery, not a reconstructed “retry failed” request with new revisions/keys.

## Concrete slice-1 command surface (accepted)

All mutation bodies are strict, bounded JSON under existing CSRF/session rules;
unknown/null members fail. Commands use existing idempotency-header semantics and
sanitized unavailable/forbidden/not-found/conflict errors. No actor selector.

| Existing authoring transport extension | Strict command / projection |
| --- | --- |
| Workspace tag collection GET / POST | Bounded keyset vocabulary list; create `{key}` with normalized identity. |
| Workspace tag resource rename / delete | `{key, expectedTagRevision}` or `{expectedTagRevision}`; atomic delete ≤50 assignments, `LIMIT 51` overflow conflicts without change. |
| Workspace tag assignment discovery | Owner/admin-only bounded keyset pages of assigned workflow IDs and organization revisions, including archived targets for explicit cleanup. |
| Workflow organization GET | Opt-in existing workflow GET projection described above, same workflow-read authority. |
| Workflow tag replacement POST | `{tagIds, expectedOrganizationRevision}`; unique UUID array, at most 16, canonical UUID sort, atomic replacement and one revision advance. |
| Admin tag cleanup detach POST | `{tagId, items: [{workflowId, expectedOrganizationRevision}]}`; unique ≤50 explicit workflow IDs, current owner/admin per-item authority, archived allowed, independent ordered outcomes and frozen per-item identities. |
| Workflow favorite POST | `{favorite, expectedFavoriteRevision}`; explicit boolean and `absent`/opaque UUID token; current read authority including viewers. |
| Existing workflow list GET | `query` ≤128 UTF-8 bytes, `view=active|archived|all`, optional `tagId`, `favoritesOnly=true`, `include=organization`, existing `order/limit/after`; exact query names finalized by primary before schemas. |

Proposed successful metadata command returns only its scoped metadata outcome and
`replayed` flag, not changed strict workflow summaries or a graph. Revisions use
existing safe-integer positive revision conventions where numerical; untouched
organization starts at revision 1. Favorite tokens are not shared revisions.
No-op replacement still advances once for a new accepted command, avoiding an
ambiguous concurrent same-revision winner; exact replay never advances again.

## Additive rollout, rollback and evidence gates

New child relations use existing UUID/composite tenant keys and workflow/workspace
lifetime; least-privilege grants, actor RLS for favorites, current membership
checks, required indexes and bounded purge integration are mandatory. Shared
metadata commands have sanitized audited actions; private favorites should not
be exposed through workspace-visible audit data. Executable graphs, published
versions, template origin and portable exports do not gain organization fields.
Recommend duplicate/import starts with no shared assignments/folders/favorites
unless an explicit later copy option is accepted; ordinary same-workspace
duplicate retains only its existing ADR060/063 obligations.

Install additive schema/readers/guards while new writers and controls are off.
Qualify exact head/helper/schema/ACL inventory under the existing strict readiness
cutover policy; no widening readiness for an old image. Enable only after contract,
real RLS/restart/race/purge and browser/backend evidence. Rollback hides controls
and disables new writes, retains metadata and compatible readers, and preserves
old workflow identities/default reads/archive states; no destructive down migration.

Required tests: normalization/collision/deletion race; viewer favorite privacy;
membership suspension/removal/rejoin; cross-tenant IDs and cursors; filter-before-
pagination and wildcard escaping; stale tag-set/favorite/folder writes; lost reply
exact replay; archive/restore; folder cycle/depth and opposite concurrent moves;
bulk partial outcomes; legal hold/deletion/purge; old strict readers and exports;
real keyboard/browser navigation and identity-scoped cache cleanup. Mocks and
source presence do not close persistence or live gates.

## Primary acceptance checklist

- Shared tags versus personal bookmarks; canonical tag algorithm, limits,
  vocabulary authority and deletion semantics.
- Separate revision/idempotency/privacy model, suspension/removal/rejoin behavior,
  duplication/export non-inheritance and private audit treatment.
- Authoritative filter/projection/cursor contract and live-pagination guarantees.
- Folder hierarchy lock/depth/delete/move semantics and bulk atomicity/outcomes.
- Additive compatible reader/writer rollout, retention/purge and exact-source gates.

Primary clarification incorporated: bounded atomic tag deletion ≤50 affected
workflows, zero-change overflow discovered with LIMIT 51, explicit authorized
archived cleanup and fresh confirmation after changing the intended operation.
The primary accepted these documents at `a0508cd0` after full exact-source review.
List query names are finalized as `query`, `view`, `tagId`, `favoritesOnly`,
`include=organization`, and existing `order`/`limit`/`after`; schemas must strictly
enforce their documented bounds, enums and unknown-member handling.

Cursor HMAC keys must use the established secret/configuration owner with stable
cross-instance behavior and explicit rotation/fail-closed availability. No
process-random key, hardcoded fallback or logged filter payload is permitted.
Primary accepted concrete cursor bounds before implementation on 2026-10-02:
512 ASCII bytes maximum on the wire, version 1 canonical bounded payload and
HMAC-SHA256, 15-minute expiry. Bind workspace, actor, order, canonical filter hash
(not raw query text), exact timestamp/UUID position, issued-at and expiry.
Verify bounded size/encoding/version/signature with timing-safe comparison,
timestamp ranges/expiry and scope/filter/order before query; return generic
invalid-cursor detail. Prove the largest legitimate payload fits 512 and overflow
fails, cross-instance fixed algorithm vectors, tamper/expiry/key rotation and
cross-actor/workspace/filter/order rejection. Rotation requires an explicit fresh
first page preserving filters, not automatic retry loops. Existing unfiltered
default cursor behavior remains unchanged. No random/hardcoded key fallback or
logged filter payload; signing is neither privacy nor authorization.
Recovery UI must disclose
the favorite retry-horizon limitation and never automatically reset to a new key.
Folder names/sibling uniqueness and exact folder commands require a reviewed
follow-on before that slice. Folders and general bulk remain required F07 scope.

Acceptance of ADR064 is not persistence, privacy/race/retention or browser proof.
Required independent review and exact-source live gates remain open.
