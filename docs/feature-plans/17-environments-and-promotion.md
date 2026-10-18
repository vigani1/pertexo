# F17 — Environments and promotion

Status: complete; merged in [#348](https://github.com/vigani1/pertexo/pull/348). Updated: 2026-10-18.
Parent: [roadmap](../product-roadmap.md). Decision: [ADR 087](../adr/087-workspace-promotion-and-version-provenance.md).

## Outcome and baseline

An environment is an ordinary workspace. A workspace names another workspace on
this install as its promotion target. Builders review selected immutable published
versions, bind configuration to the target, then create target drafts, publish
when allowed, or request the existing F18 publication review. No environment flag
changes row security, permissions or execution behavior.

Main `cffe07669` includes F18 (#342–#343) and completed F28 (#344–#347). Existing
owners already provide immutable versions/checksums, draft CAS, portable manifests,
connection slots, variable-reference analysis, stable table-column bindings, exact
Call pins, idempotency receipts, audit retention and publication approval.

Relevant current code:

- `database/authoring/portability`: graph projection and destination connection checks.
- `database/authoring/publication`: one compile/persist/trigger/outbox pipeline.
- `database/authoring/reviews`: exact draft review; no publisher bypass.
- `workflow-model/expressions/variable-usage`: bounded static/dynamic references.
- `database/data-tables/columns/references` and `node-sdk/data-tables/bindings`.
- `database/artifacts/references`: workspace/fingerprint admission for files.
- `web/features/workflows/model/versions/diff` and `comparison.public.ts`: shared
  comparison owner, moved without behavior changes in `2addf95fd`.

Export/import alone creates a new workflow and retains source Call/column IDs.
It is not promotion provenance or a safe cross-workspace publication operation.
Do not add a second importer, publisher, execution engine or credential copier.

## Decisions and rules

### Workspaces and authority

- One optional target per source workspace; no self-target. Chained workspaces are
  ordinary independent links, with no inferred access or automatic onward promotion.
- The source workspace owner changes/clears its target using existing
  `workspace:manage`. Selecting a new target also requires current authoring access
  there. A link is configuration, not an access grant or an SSO delegation. Keep
  a cleared setting’s revision row and compare its prior target ID, so a set/clear
  cycle or target purge cannot revive an old settings request.
- Every preview/apply requires active current authoring access in source and target.
  Publication/request modes also require target `workflow:publish`. A later role,
  status or workspace change cannot be authorized by an old preview or receipt.
  Existing role/capability rules own these decisions; no new role/token scope.
- Resolve another workspace's name/configuration only after proving access there.
  An inaccessible target has a plain unavailable message, without exposing its
  contents or claiming the actor lost their source workspace role.
- All tables retain the ordinary forced `workspace_id` fence. The target setting
  belongs to the source workspace; provenance belongs to the target. Cross-scope
  reads/writes use existing scoped transactions, never an unfenced database role.

### Selected versions and binding

- Select at most twenty workflows, one retained published version per workflow;
  default to each current live version. Historical versions are selectable for
  exact Call dependencies and rollback. Source workflows must be readable/active.
  A later source publication never silently substitutes another reviewed version.
- Reuse portable projection/admission, registered definition/config versions and
  placement policy. Preserve step IDs, links, mappings, callable/input contracts
  and configuration. Reject known credential-like content as export/import does.
- Read source connection metadata only: ID, name, provider and authentication type.
  Resolve an active target connection using the existing name normalization and
  the same provider/type. Never select secret/envelope/token fields. Missing,
  incompatible or ambiguous bindings block apply with a specific requirement.
  Do not silently use a source connection ID or invent a target credential.
- Use existing variable-source/expression analysis. Require each referenced name
  in the target; show dynamic references and incomplete analysis explicitly.
  Incomplete analysis blocks apply; dynamic references remain visible for review.
  Existing authoring validation remains authoritative. Copy no variable values,
  descriptions, set revisions or snapshots. Target runs capture their normal set.
- Tables must already exist by name in the target. Resolve each source column ID
  to its current source name, then match the target column by name and type. Keep
  workflow output aliases unchanged, replacing only the stable column IDs. Check
  relevant unique-key/schema compatibility (including additional required target
  columns for inserts/upserts) and preserve existing removed-column
  fences. Missing/incompatible tables/columns block apply. Copy no schema or rows.
- Static artifact references in a selected graph block promotion: show the affected
  steps and explain using target-owned files or runtime inputs. Do not copy file
  bytes or store cross-workspace references. Runtime file mappings remain normal
  workflow configuration; pins, previews, input cases and run data never transfer.
- Trigger endpoint keys, webhook authentication secrets, public-form grants,
  connection health, alerts, concurrency policies and other operational settings
  remain target-owned. Promoting a graph is not copying workspace/workflow runtime
  settings. New publications use normal trigger reconciliation and fresh endpoint
  credentials. New public forms keep the existing members-only default. Explain
  that publishing can activate target schedules; drafts do not activate anything.

### Call dependencies and immutable provenance

- Rebind a Call only to a retained target version proven to come from the exact
  source child workflow/version/checksum. Never match a child by name alone or
  repin to its latest version. Reuse ordinary Call closure/contract/expansion rules.
  Include the actual target counterparts’ transitive connection/variable requirements
  in the bounded review, without transferring dependency data.
- Promote a child first, publish it (through F18 review when required), then promote
  its parent. Missing counterparts are explicit review requirements with links to
  promote that exact child version. This also handles two historical versions of
  one child through sequential promotions. Applying a parent with unresolved pins
  is blocked; no dangling source pin or unapproved immutable version is staged.
- Target workflows remember their source workspace/workflow and the last applied
  source version, mapped graph digest and target name. One source workflow maps to
  one target copy per workspace; later promotions find that copy by identity.
  Never implicitly adopt an unrelated target workflow with a colliding name.
- Publication records version correspondence only when the published candidate
  still matches that promoted draft. This includes later ordinary/F18 publication
  and checksum reuse. A manually edited draft cannot acquire false provenance.
  Keep immutable correspondence facts for retained target versions; checksum reuse
  and rebinding may produce many-to-many correspondence, without erasing history; resolve the
  most recently published valid counterpart when more than one is available.
- Provenance does not retain source data through a source purge: source identifiers
  and checksums are opaque metadata, without a foreign key pinning source versions.
  Target copies/versions remain independent; target workflow/workspace deletion
  removes their provenance. Existing replay/recovery/Call pins remain unchanged.

### Review, conflicts and apply

- The server returns proposed target graphs, current target drafts/live context,
  binding requirements, exact source versions and direct-edit conflicts. Show step,
  mapping/link and workflow contract changes, with inspectable configuration.
  Reuse the version comparison owner rather than maintaining another diff rule.
- A direct edit is a target name/graph change since its last promotion, or an
  independently changed publication. Preserve those changes by default. Explicit
  per-workflow acknowledgement may replace them after review. An unrelated name
  collision remains blocking; do not silently adopt, rename or merge workflows.
- Review carries an opaque SHA-256 fingerprint over selected versions, proposed
  graphs/names, current target revisions/publication/provenance, bindings/schema,
  target variable names/head revision, link revision, catalog and publication
  policy. Store no review graph/token in PostgreSQL. Apply recomputes that same
  review under locks and refuses stale fingerprints before changing anything.
- API request selectors are IDs, acknowledgements, mode and an optional bounded
  note, not caller-supplied executable/target graphs. Parse once at the boundary.
  The authoring module owns binding/validation; SQL stores/fences, not business rules.
- Lock workspace identifiers first in sorted order, then the actor/memberships and
  workflow/draft rows in deterministic order. Use one existing pool checkout and
  one transaction for the bounded apply. Start with no tenant installed and use
  scoped callbacks per workspace; do not nest scopes inside an already-scoped
  authoring transaction. The authoring lifecycle tracks the shared checkout. Do not hold it while rendering/waiting
  for a user. Check current permissions, link, target policy and requirements again.
- Apply is all-or-nothing for the selected batch. Claims/receipts use existing
  idempotency ownership; lost responses retry exactly the same request. A stale
  review or failed publication leaves all drafts, histories, provenance and outbox
  rows unchanged. Missing requirements never cause a partial import.
- Modes: **Create drafts** (default), **Publish**, or **Request approval**. Publish
  must pass the existing publisher's approval policy in the same transaction.
  Request mode uses existing F18 request admission, exact draft tag/note, limits,
  inbox audience and notices. A different current owner/admin approves there.
  No special promotion approval or administrative bypass.
- Promotion audit facts record actor, source/target IDs, versions, revisions, mode
  and promotion ID in each affected workspace; never graphs, values or credentials.
  The feature's history is a safe projection of those existing facts, paged by ID,
  following workspace audit retention (365 days by default). Do not create another
  event ledger. Persistent origin/version correspondence lasts with target data.

## Bounds, structure and delivery

Initial bounds: twenty selected workflows, one version each, combined source and
current target graphs (including inspected dependencies) within 2 MiB, response
within 4 MiB, existing per-graph and
expression/dependency budgets unchanged, history pages up to fifty. Refuse a large
batch with “select fewer workflows”; do not buffer unbounded history or graph sets.
Measure the maximum before final qualification and reduce a bound if necessary.

One feature PR, with coherent commits and moves separate from logic:

1. Reconcile this plan, accept ADR 087 and record glossary terms before code.
2. Move shared UI graph comparison to its workflow owner, updating imports only.
   Extract the existing direct-publication policy into a shared internal operation
   without changing behavior, so promotion and normal publishing have one guard.
3. Add three typed authoring schema tables under `schema/authoring/promotions/`:
   source target links, target workflow origins and target version correspondence.
   Generate migration 0035; preserve forced RLS/grants/purge and update the four
   legacy-upgrade migration expectations. Keep origin identifiers separate from
   any secret/run-data store. Verify migration and retained historical versions.
4. Implement `database/authoring/promotion/` grouped into settings, preparation and
   apply/publication responsibilities, with a small store interface: settings,
   candidates, preview, apply and history. Reuse the current authoring context,
   scoped transaction helpers, portability catalog, variable/table/artifact owners,
   publisher/reviews, audit and command receipts. Add `.promotions` to the authoring
   database composition; no new package entry point or independent pool.
5. Contracts own zod/OpenAPI settings, selectors, review/requirements and results.
   API `workflow-authoring/promotion/` owns guarded browser commands and safe error
   mapping, wired through the existing runtime/module. Endpoint group under
   `/v1/workspaces/:workspaceId/promotions`: settings, candidates, preview, apply,
   history. Target IDs never confer authority. No machine-token scope expansion.
6. Web `features/workflow-promotions/` owns page, API/queries, retained commands and
   review UI. Routes compose it at workspace Settings → Promotion; workflow list
   selection and version actions link there with bounded selected version IDs.
   Owners configure targets; authors select, compare, acknowledge direct edits and
   apply; everyone gets clear missing-binding/policy feedback before an action.
   Target draft/version/review links and a history lane make results inspectable.
   Keep Weft, plain forms, keyboard use, phone layout and reduced motion.
7. Qualify, document `docs/guides/environments.md`, update tracker/roadmap, normal
   hooks and exact-head green CI, then rebase-merge. Finish F17 before F19.

Frontend snapshots belong to Query with zero retention for detailed reviews and
no persistence. URL owns selected workflow/version IDs. A background refresh
preserves an edited review/acknowledgements until explicit re-review; a new target,
revision or policy invalidates confirmation. Permission loss clears protected data.
A lost apply response keeps its exact retained command and prevents a new action.

The 20-workflow measurement found that storing the entire result exceeds the
existing 4 KB idempotency receipt bound. The receipt stores only promotion and
target IDs; exact retries reconstruct the result from the same source audit facts
written atomically with apply. Audit retention is at least 30 days, longer than
the 24-hour retry window. No second ledger or enlarged shared receipt cap.

The existing live-browser job runs promotion as its own owned scenario. Combining
it with the governance scenario exhausted the unchanged public authentication
rate limits across unrelated users. Scenario isolation gives it a fresh disposable
API/database/Redis namespace; no new CI job or rate-limit bypass is added.

The real promoted parent/child qualification exposed a pre-existing F14 privilege
gap: Call preflight runs under maintenance authority and its table-reference
`FOR SHARE` failed with SELECT-only metadata access. The additive migration grants
maintenance `UPDATE(id)` on table definitions, the narrow PostgreSQL privilege
needed for that row lock. It grants no column-schema or row-data updates, and
keeps the existing three roles and admission lock order.

## Acceptance and rollout

- Real PostgreSQL/app-role tests: source/target permissions and revocation, forced
  RLS across unrelated workspaces, link CAS/clear, name collisions, every binding,
  alias preservation, missing/dynamic variables, file refusal, drift between review
  and apply, concurrent applies, same-command replay, atomic rollback and purge.
- Publish/approval tests prove no F18 bypass, exact reviewed revision, stale later
  edits and no provenance for manual edits. Child → approved target child → parent
  binds exact target versions, including historical children/checksum reuse.
- Run a promoted parent on the real worker: it must use target connections,
  variable values and table data, call target children and preserve source history.
  No real external providers; use owned local test services and current fixtures.
- Real browser journey on desktop/375px: configure two workspaces, review missing
  setup, fix it, preserve target edits until acknowledged, create/promote drafts,
  review/approve where required, inspect history and run the target. Add mocked
  regression cases, app build/lint/types/units and React Doctor without suppressions.
- Measure maximum review/apply bytes, process memory and transaction time. History
  and configuration reads release checkouts before responding. No Docker download,
  hosted service, paid account or infrastructure change is needed.
- Additive migration/reader rollout. Old authoring paths remain unchanged; UI
  handles unavailable promotion support plainly. Rollback uses the target's existing
  version restoration/publication/review, never a database reset. The next promotion
  shows manual rollback as a conflict rather than overwriting it silently.

Retained version pickers use the same paged candidate metadata owner, filtered by
workflow and version number. They never reuse the existing full-graph history
query, fetch every retained graph on opening, or add that history to the review
cache. The selected version remains exact even if it is on an older page.

## Local evidence (2026-10-18)

- 41 real PostgreSQL cases cover promotion, binding, approval, full workspace purge, schema shape and
  legacy upgrades. The API HTTP journey verifies session/CSRF authority, strict
  input, review, apply and replay through the actual runtime.
- The real worker runs a promoted parent and exact child using target-only
  credentials, variable `RATE=7` and table amount `900`; source `RATE=42`, its
  original credential reference and immutable version remain unchanged.
- The owned promotion browser scenario creates workspaces and a workflow through
  the UI, promotes a draft, publishes/runs it and inspects history at 1280/375px.
  Screenshots are inspected locally; no horizontal overflow. React Doctor: 100,
  no issues or suppressions after the composition and stable-key pass.
- Maximum batch: 20 definitions with 50 KB configuration each, about 2 MB across
  source/target graphs; response 2,019,147 bytes. Review ~1.00 s, apply ~1.12 s.
  In this cumulative test process RSS rose 305.9→310.4 MB; lifetime high-water
  was 366,688 KiB. These are local observations, not a deployment memory bound.
  A larger combined review is refused before writes; the shared 4 KB receipt
  bound stays intact.

CI also caught the two provenance tables missing from the explicit purge policy
inventory. Cascades already removed their rows, but purge now names both as
bounded steps before deleting drafts and versions. The unchanged full workspace
purge suite verifies coverage as well as deletion.

A later CI run exposed an existing trigger-consumer setup race: it awaited the
consumer but published before the independent producer finished connecting. The
test now awaits both existing readiness contracts before publishing; reconciliation
retry behavior and production code are unchanged.

## Later

Git source control, promotion across installs, automatic onward promotion, copying
files or table schemas/data, environment-specific secret/variable replication,
automatic child publication bypassing review, and folder-level ACLs (F18 later).

## Tracker

- [x] Baseline, decisions and ownership reconciled against current main.
- [x] ADR 087 and glossary capture linked workspaces and reviewed provenance.
- [x] Move/refactor commits preserve current behavior (`2addf95fd`, `375360f31`).
- [x] Contracts/schema/binding/apply/history and publication integration qualified.
- [x] UI, real worker/browser acceptance, maximum bounds and guide qualified.
- [x] Exact-head CI green; rebase-merged as `329c5f0c8`. Natural main CI 39117830698 and CodeQL 39117830693 passed from that commit.
