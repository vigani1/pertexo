# F48 — Finer sharing

Status: in delivery. The owner approved the plan as written on 2026-10-21;
plan PR #458 is merged. Deliver slices 1–4 in order, one PR per slice.
Owner authorized the scope and delegated recommended choices on 2026-10-21.
Decision: [ADR 090](../adr/090-resource-sharing-within-workspaces.md).

## Outcome and current owners

Keep the workspace as the tenant. Optionally restrict a workflow folder to named
members or existing directory groups, and a connection to named members. Existing
resources remain workspace-shared until an administrator changes them.

The baseline has F07 folders (256 per workspace, depth four), organization revisions,
workspace role/capability policy, F28 SCIM groups and immediate membership removal,
F18 audit/publication review, F17 promotion, immutable published versions and F02
draft tests. There are no resource ACLs today. Extend these owners; do not add
projects, local group management, a role, service, cache, permission subsystem or
second authorization language.

Benchmarks checked 2026-10-21: [n8n projects](https://docs.n8n.io/administer/manage-users-and-access/set-permissions-and-roles-rbac/organize-work-in-projects.md),
[n8n credential sharing](https://docs.n8n.io/administer/manage-credentials/share-credentials-securely.md)
and [Zapier shared folders](https://help.zapier.com/hc/en-us/articles/39703938224781-Manage-assets-in-your-Zapier-account).
The following inheritance and role-ceiling rules are Pertexo decisions.

## Rules

### Workspace and folder access

- Current active workspace membership and account/workspace status remain required.
  Owners/admins retain full access. Workspace capabilities are always the ceiling:
  a folder Editor grant never makes a workspace operator/builder an administrator,
  and a workspace viewer remains unable to start runs.
- A folder is `workspace` (default) or `restricted`. Restricted grants are Viewer
  or Editor to a member or an existing SCIM group linked to this workspace's
  identity organization. Viewer permits workflow read and published-run actions
  already allowed by the workspace role; Editor additionally permits authoring
  and publishing allowed by that role. No separate workspace roles.
- At one folder, take the person's highest matching member/group grant. Across
  restricted ancestors, take the lowest grant; missing any ancestor grant denies
  access. An unrestricted child cannot widen a restricted parent. Unfiled workflows
  retain today's workspace access. Existing folder count/depth bounds stay.
- A workflow and all its retained versions, runs, previews, draft tests, samples,
  files, comments and presence follow its current folder. There is no per-workflow
  ACL format or per-run permission snapshot. Direct inaccessible reads return the
  existing non-disclosing not-found result, and lists omit them before pagination.
- Run/preview file discovery and fresh downloads require a visible retained owner.
  Reuse F04 reference facts; new draft/input/pin references check source access
  before persistence, so a submitted reference cannot authorize itself. Standalone
  user uploads remain workspace assets; an existing reference in another readable
  workflow is deliberate sharing of immutable bytes. No new artifact ACL format.
- Groups reuse current active, non-deleted directory-user bindings and membership;
  provisioning does not revive removed/suspended workspace membership. No new
  local groups. Unlink/deletion removes corresponding group grants so re-linking
  cannot revive them. Membership removal clears named grants; suspension pauses
  their effect while preserving the existing suspension/restoration behavior.
- Only owners/admins change restrictions/grants. Allow at most 100 distinct
  principals per restricted folder; an empty list means administrators only.
  Changes use the existing revision/idempotency contract and metadata audit facts.
- Creating/editing a workflow in a folder requires Editor there, within the
  workspace ceiling. Folder management keeps its existing administrator roles.
  Moving checks source and destination in the same transaction. Ordinary legacy
  moves remain unchanged; moves that remove or replace an effective restriction
  need an administrator's explicit audience review. Never infer that two directory
  groups have equivalent future membership. Moves that only add restrictions can
  keep the existing editor authority. Keep the existing empty-folder-only delete
  rule; contents move explicitly rather than silently becoming unfiled.
- New Call bindings require target read access. Error-workflow settings retain
  their stronger edit-both rule. Promotion checks source read and target create/edit
  authority as well as its existing workspace requirements. Publication approval
  remains authoritative; an ACL cannot bypass review or permit self-approval.

### Connection sharing and execution

- Connections default to `workspace`. `restricted` permits their active creator,
  listed active members and workspace owners/admins, within the `connection:use`
  ceiling. At most 100 named members. A grant conveys Use, never plaintext secret
  access, rotation, revocation or sharing administration.
- Owners/admins manage sharing through the existing connection authority and
  revision/idempotency fences. A removed creator gains no exception; administrators
  can always recover/manage a restricted connection. Secrets and key providers stay
  exactly where they are.
- Changing a connection reference checks Use. Every new publication, single-step
  real preview and whole-draft test checks all referenced connections, including
  unchanged references. Otherwise changing an HTTP destination or upstream mapping
  could exercise a credential the editor cannot use. Ordinary draft saves preserve
  an unchanged unavailable binding and show a generic unavailable identity.
- Already accepted immutable published execution bindings keep working after a
  sharing change, including published manual/API starts, schedules, webhooks/forms,
  Calls, error workflows and recovery. Running an approved published workflow is
  deliberate delegation; it is not general permission to reuse its credential in
  another definition. Revocation of the connection itself still uses existing rules.
- Published execution outputs may deliberately contain data from another workflow;
  grants do not add taint tracking or rewrite retained outputs. A parent run does
  not grant direct access to a hidden child run or its private step history.
- Connection pickers, use/health views and promotion expose only permitted metadata.
  Hidden bindings do not reveal private connection names through errors or usage.
  Exports/imports/promotions copy no ACL, secret, pin, run data or table rows; target
  folders/connections use the target workspace's own current rules.

### One authorization owner and revocation

- Extend `database/tenant-access` with a small `resources/` area: typed facts,
  pure policy, batched fact reads, allowed query scopes and transaction fences.
  It imports the existing role/capability owner. All consumers use this rule; API
  decorators and frontend code must not implement another grant evaluator.
- Add `workflow_folders.access_mode` and workspace-fenced `workflow_folder_grants`
  beside the existing authoring schema; add `connections.access_mode` and
  `connection_shares` beside the connection schema. Modes default to workspace;
  grant rows reference existing member/group identities, never copies of people.
- SQL stores modes/grants with constraints, indexes, workspace foreign keys and
  ordinary forced workspace RLS. It may filter by scopes already calculated in
  TypeScript; no SQL role/ACL function or policy language. Reuse the existing
  directory identity exception for group facts, behind the workspace link fence.
- Fetch bounded folder facts, the actor's relevant groups and only matching grant
  facts once per read transaction; do not load every other member's grants. Apply the resulting scope before pagination, counts, text search
  or aggregation. No request/query per row, post-page filtering or global cache.
- Cover authoring/version/portability/review, organization/favorites, run reads and
  commands/values/statistics, preview/test/suite history, artifact admission/download,
  SSE, inbox/tasks, comments/presence, promotion and personal-token APIs. Notice
  audiences compose workflow read access with the existing F27 eligibility owner;
  email/digests recheck before delivery. Existing workspace limits/capacity/storage
  totals remain workspace facts, with no hidden workflow identities.
- Sensitive commands lock current authority and their resource facts in the same
  transaction, using workspace-first ordering. Access/tree changes and SCIM/group
  projection serialize with those fences. Idempotency cannot resurrect revoked
  authority. Group, membership and role removal remain immediate on the server.
- SSE and each bounded export batch recheck access, without pinning a pooled
  connection while waiting on a client. Permission denial clears affected query
  data/active views. Already received data cannot be recalled, and existing signed
  file URLs remain valid only for their current short TTL; no new download proxy.
- Grant edits and audience-changing moves append one bounded metadata-only F18
  fact in their command transaction. Existing directory/membership audit records
  remain the facts for group/role changes. Grant rows follow resource deletion and
  workspace purge; no independent retention policy or copies inside workflow JSON.

## Slices and acceptance

One PR per slice, after this plan/ADR PR merges. Moves are separate commits.
Each PR runs the full hook and relevant existing tests and merges only green.

| Slice | Existing owners and delivery | Required proof | Status |
| --- | --- | --- | --- |
| 1. Folders | `tenant-access/resources`, `schema/authoring`, `authoring/organization` and workflow/run/inbox/artifact consumers; contracts/API routes. All folder fences land before restrictions can be used. | Populated migration unchanged defaults; role ceiling, ancestor intersection, group/manual/removed memberships; every direct/discovery path; no pagination/count leaks; move/revoke races, audit/purge and current published jobs. | Delivered |
| 2. Connections | Existing connection reads/authority, authoring/preview/test/publication/portability/promotion admission; schema/grants and sharing endpoints. | Existing bindings keep executing; reference change, URL/upstream change, preview/test/publish require Use; metadata non-disclosure, revocation races, no secret/export copying. | Planned |
| 3. UI | Existing workflow organization, connection and promotion features; server-projected actions and normal Weft forms/principal pickers. | Sharing and audience review, unavailable bindings, read-only editor, query invalidation; keyboard/reduced motion; desktop, 990 px pane and phone in both themes; mocked and real browser journeys, React Doctor. | Planned |
| 4. Qualification | Existing database/API/worker/browser checks, guides and delivery tracker. No new CI job. | Repeat the cross-surface negative matrix, SCIM removal, tokens, accepted public/Call/callback execution, approval/inbox/mail, slow export/SSE and restore/purge. Natural main CI inspected after merge. | Planned |

Later: direct per-workflow exceptions, local group management, cross-workspace
sharing, ACLs for tables/variables, external policy engines, and revocable download
proxies. F21/F22 remain later. Production/provider qualification is separate from
local and merged CI evidence.

## Slice 1 delivery details

The folder implementation uses one workspace-bound scope from
`tenant-access/resources`. Authenticated workflow/run reads, inbox/mail, files,
variable and connection usage, trigger management, promotion and commands compose
that scope with their existing capabilities. Accepted immutable background jobs
retain their execution bindings.

Audience reviews return one concurrency token per selected workflow (at most 50)
or one folder. Each token binds the current folder tree, destination and that
resource's organization revision. This lets a bulk move finish independently per
item without making later items stale because earlier items moved. Review tokens
are not credentials and persist no new format. Principal revocation advances
folder revisions as it clears grants, invalidating open sharing forms.

Fresh file access also honors the existing run-data expiry rules before retention
cleanup catches up; durable references in another readable owner deliberately
share the immutable bytes. See [Sharing within a workspace](../guides/sharing.md).

Call admission compares each stable node path and exact target pin. Ordinary saves
preserve unchanged bindings; new publications and draft tests recheck every direct
Call target. Immutable children retain their delegated execution closure.

Existing retained-run reads in suspended or pending-deletion workspaces remain
available to active members, subject to current folder grants. Authoring and new
execution admission still require an active workspace. Qualification uses a
private disk-backed CI temporary root because Ubuntu 26.04 mounts `/tmp` in RAM;
production scratch refusal remains unchanged.
