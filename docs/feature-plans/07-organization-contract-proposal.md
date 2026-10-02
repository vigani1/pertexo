# F07 — Workflow organization contract proposal

Status: **PROPOSED — primary review required, not accepted or implementation-authorized.**
Inventory source: `1433780b8540545bea66ba9f39aff9e44f40e3c3`, 2026-10-02.
Parent: [F07](07-workflow-organization.md), [roadmap](../product-roadmap.md).
This is read-only source reconciliation plus a recommendation, not runtime proof.
F06 qualification remains the active delivery priority. No migration or ADR number
is allocated here; the primary must reconcile the global ADR/migration inventory
immediately before accepting consequential decisions or persistent implementation.

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

## Recommended delivery scope

1. Tags and private favorites, with authoritative bounded list filters and a
   useful browser list/row interaction. No enabled placeholders.
2. Folder navigation, individual moves and folder administration after its
   hierarchy/race model is accepted. Folder placement never changes permissions.
3. Explicit bounded bulk tagging/moving, with per-item outcomes and stale-write
   conflicts. Do not omit these from F07, or claim them complete with slice 1.

Do not create a package, worker job or external search service. Keep durable
transactions/projections in database authoring, transport in API authoring,
browser-safe schemas in contracts, and UI/Query/Router state in web workflows.

## Proposed slice-1 semantics requiring acceptance

### Shared tags

Recommendation: workspace-scoped stable tag IDs and unique canonical keys;
workflow assignments reference tag IDs, not duplicated labels. Initially use
lowercase ASCII kebab-case keys, 1–32 bytes, at most 16 tags/workflow and 256
live tags/workspace. Accept uppercase ASCII input only through an explicitly
specified lowercase normalization, trim ASCII outer spaces, reject any remaining
invalid characters; never silently transliterate Unicode. Return the canonical
key before confirmation. Bounds are server-enforced, not caller-configurable.

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

Delete a tag by an explicit owner/admin command that atomically removes its
assignments, without deleting/changing workflows. Lock the tag row to fence
assignment races. Tag IDs are never reused; later recreation has a new ID.
Rename preserves ID and assignments, rejects canonical-key collision, and uses
its own expected revision. No hidden tag merges. Archived workflows retain tags;
archive/restore never rewrites assignments. Global deletion affects archived
assignments too and must say so in confirmation.

Workflow tag-set replacement is bounded and revision-checked. Use one independent
organization revision and an exact normalized command identity; concurrent
changes from the same revision yield one winner and a stale conflict, never a
silent lost update. Replaying a committed identical command returns its recorded
outcome after current authority; same key/different command conflicts. Name,
graph and lifecycle revisions are independent. Lock ordering and archive/update
race outcomes must be specified alongside the concrete migration design.

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

Suspension denies access immediately but preserves bookmarks for reactivation.
Recommendation: permanent membership removal deletes that membership's private
favorites atomically; rejoining starts without old private state. User deletion
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
Escape SQL wildcard metacharacters so name search is a literal substring;
document actual database case semantics, not unspecified JS-locale equivalence.
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

Cursor binds version, workspace, actor, order and canonical filter identity plus
timestamp/UUID position; reject changed-filter cursor reuse. Existing unfiltered
cursor semantics remain accepted on the old path. Query keys include the same
normalized filters/projection under existing user/workspace cancellation prefix.
Changing filters resets pagination and preserves URL state through navigation.
Keyset pagination is live, not a snapshot: concurrent workflow edits may move
items; clients deduplicate IDs and refresh explicitly, with no completeness
claim from loaded-page counts. Prefer existing ordering timestamps unchanged by
tag/favorite-only writes, so discovery actions do not reshuffle recent workflows.

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

These are candidates for one coherent next-free ADR, not several routine ADRs or
an accepted decision. Numerical proposals and transport shapes remain reviewable.
