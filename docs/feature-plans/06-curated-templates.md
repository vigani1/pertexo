# F06 — Curated workflow templates and guided setup

Status: ADR063/contract accepted after primary and independent review; implementation authorized, qualification/release open.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Frontend-led over portable authoring. Relative size: **M**, not a calendar estimate.

## Outcome

New users can start useful automations without assembling every node from scratch.

## Current implementation and evidence

Workflow creation/onboarding and F05 portable authoring exist. The old N5 plan
describes a proposed chooser, not a shipped template library. This preparation
uses exact F05 candidate `a0d69f57cdae5fe88fbf81f117f76c0714d07fe3`, not a claim
that F05 is merged or released. Recovery repair `169b776` and confirmed-only
fresh-import follow-up `ba997c39` are integrated by normal fast-forward.
Original snapshot and uncommitted preparation edits remain
preserved; no history rewrite or release claim.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [apps/web/ARCHITECTURE.md](../../apps/web/ARCHITECTURE.md)
- [apps/web/src/features/workflows](../../apps/web/src/features/workflows)
- [ADR060](../adr/060-workflow-duplication-identity.md) and
  [ADR062](../adr/062-portable-workflow-authoring.md)
- [portable HTTP schemas](../../packages/contracts/src/http/workflow-portability.ts)
- [catalog cohorts](../../packages/node-catalog/src/registry.ts)

Preparation checked 2026-10-02. The accepted identity contract allocates only a
new outer workflow ID: graph-local node/scope IDs, edges, structured mappings and
dynamic expression text are preserved. There is no safe expression remapper.
F05 requires explicit valid destination bindings for every required connection
slot before creation. The former “remapped draft, credentials unconfigured”
acceptance is therefore superseded, not authority to weaken F05.

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

Implementation foundation update (2026-10-02): accepted decision recorded in
`be6d91e3`; immutable three-asset/model and separate registered input/config
policy in `fb4a2890`; additive HTTP/API origin forwarding, scoped projection
capability and conditional command identity in `28a54ab6`. The chooser/guided
setup uses the existing mounted recovered import session and remains explicitly
off. Retained-origin presentation is implemented behind an independent off gate,
using the strict opt-in GET under the existing scoped query prefix; no asset
lookup or current-safety inference. File-read/example-selection ownership is
regression-tested (`f088e4dc`). No persistent origin SQL writer/reader, inheritance or migration has yet
been installed; the opt-in API fails unavailable without a supported reader.
That foundation preceded the combined-base handoff recorded below.

Persistent continuation update (2026-10-02, unqualified working tree): the exact
reviewed F02/F05 base `f543283825887165889f7520655558b2a3f9229c` is integrated by
normal merge `69c10d3b`, preserving all six F06 foundation commits through
`7b8839f4`. This remains an unmerged local dependency, not a natural-main or
hosted-CI claim. The release owner allocated additive migration 0133 to F06.
The combined merge passed the TypeScript build, 160 contract tests, generated
OpenAPI checks and focused API/web checks. The release owner's historical 160
database tests belong to its frozen `af76b53e` tree, not an F06 rerun at `f5432838`.

Uncommitted continuation prepares generated owner descriptors, child origin/RLS
schema, atomic creator/inheritance changes, scoped origin reading, origin-aware
runtime verification/replay, and an explicit owned-build browser gate. Descriptor
drift/schema checks and focused runtime unit checks pass; they are not real
PostgreSQL or browser/worker qualification. Migration 0133 is unfinished: its
HTTPS SQL validator and synchronized readiness inventory are not implemented.
No migration has been applied outside disposable owned qualification databases,
no template writer enabled, and no real template journey has run. Do not deploy
or commit this partial migration as a usable checkpoint.

Independent partial-candidate qualification at migration SHA-256
`29d3d434fa146e720ee414881ddff13f7d45bc0fe42fcd068113ea2435c4f99e`:
16 owned PostgreSQL boundary tests pass with explicitly owner-seeded origin,
writer off, and the current candidate correctly NOT READY. They cover descriptor
and origin ACL/RLS, the actual descriptor SHARE barrier, immutable descriptor
content, default/opt-in reads, duplicate inheritance/replay after retirement,
membership-loss denial with retained metadata, and the child FK cascade. This is
not guard-accepted creation, old-image cutover, hold/purge protocol or live
browser/worker qualification. Exact disposable databases/connections were removed;
only task-owned PostgreSQL/Redis containers and volumes are retained stopped.
The URL decision oracle is recorded in `b69a940b` (74 focused / 153 catalog tests
pass); merged problem metadata is grouped without artifact drift in `4b38ea7a`.

The HTTPS guard cannot safely be approximated by a Unicode-host regex or
PostgreSQL `inet`: the accepted WHATWG rule admits IDNA and noncanonical valid URL
forms while rejecting invalid punycode/joiner hosts. A full SQL-side URL/IDNA
implementation or an explicitly reviewed narrower shared policy was needed.
The human subsequently authorized option 3 through the roadmap manager: a
narrower curated-only HTTPS grammar. Its exact bounded v1 grammar, compatibility
change, versioned descriptor value kind and rationale are recorded in ADR063 and
the contract for primary review before implementation. Ordinary HTTP/F05 behavior
remains unchanged. No policy implementation, parser dependency or writer
enablement has occurred; persistent qualification, cutover, rollback and release
criteria remain open.

Foundation verification: 215 model and 124 catalog unit tests; 154 contract tests
with regenerated artifact/OpenAPI checks; 113 focused API tests and two receipt
identity tests; latest 887 web unit tests across 117 files and 38 focused
setup/recovery/origin tests. Relevant
builds/typechecks, scoped lint, browser import/export checks and architecture/
complexity ratchets pass; React Doctor changed score 89 retains the same six
advisory identities. Fresh pure proof of the actual repository assets passes
selected placement, authoring admission, F05 binding/reprojection and executable
compilation for all three at epoch 38, with default-core rejection. Its bindings
are synthetic; this does not establish database authority, execution or delivery.
Owned HTTP/PostgreSQL/browser/worker journeys and compatible cutover tests remain
open. The accepted feature is not complete or release-qualified.

## Dependencies and planning gate

05; supported catalog and approved first examples.

Examples and audience approved before implementation; no separate template backend if immutable reviewed assets suffice.

Bounded manager approval recorded 2026-10-02:

1. Technical first-time builders/operators and all three instructional examples
   below, only in the supported `validate_activation` profile (epoch 38 at the
   baseline). Default `core` remains unavailable; no automatic cohort switching
   or production deployment.
2. Guided binding **before** creation. Assets have no
   destination connection IDs or secrets; the resulting draft has explicit
   destination bindings. A draft with missing required bindings is a different
   policy requiring a separately justified decision, not an F05 exception.
3. Durable historical provenance via existing atomic import/scoped reads; no
   listing backend, second importer or global store. Assets-only provenance
   deferral is not the selected scope.

The manager accepted [ADR063](../adr/063-curated-template-historical-origin.md)
and the [concrete contract](06-template-origin-contract.md) after primary and
independent review and closure of the strict-readiness cutover and typed-setup
clarifications. Persistent implementation is authorized; migration allocation
awaits the manager's reviewed combined F02/F05 base. Keep chooser/new template
writers off until owned integration proof. None of these
approvals authorize provider effects, spending, production or publishing/running.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Reviewed template manifests and normal workflow-authoring instantiation; web workflow creation; no second graph importer.

Repository assets own immutable template ID/version, purpose, setup instructions,
effect disclosures and an F05-format manifest. Web `features/workflows` owns the
chooser/setup and scoped command recovery; its feature mutation module owns
server writes and cache effects. Workflow-model retains portable policy and
graph semantics; contracts/API/database change only for an approved persistent
provenance contract. Do not add a catalog service, global state store, parallel
importer, or disconnected create-then-save sequence.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Chooser with purpose, required inputs/connections, effects and setup checklist; instantiate into a draft and guide remaining configuration.

Approved audience: technical first-time workspace builders learning the
supported catalog and existing operators needing a reviewed starting example.
These are bounded instructional patterns, not ready-to-run production recipes.

Journey: New workflow → choose example → inspect complete graph, purpose,
required trigger input, bounds and effects → choose a name, permitted ordinary
configuration and explicit destination connections → normal F05 preview →
explicit Create draft → open independent draft. Editing setup invalidates the
preview; creation freezes the exact configured manifest, name, bindings,
compatibility fingerprint and idempotency key. No automatic POST retry or second
key after an uncertain response. Reopening/dismissal/navigation must retain or
protect the unresolved scoped command; session/workspace/authority loss clears
private data and fences late results. A confirmed destination opens without
another creation. A deliberate fresh-authority-checked Start another import is
available only after confirmed acceptance; it clears setup without posting.
Sending/uncertain commands have no reset/new-key path. Browser restart is not a
durable command-recovery promise.

The chooser shows unavailable examples with a specific compatibility reason,
not enabled placeholder actions. Live destination catalog/preview is decisive;
never switch the deployment cohort automatically. Setup does not collect secret
credential bytes; use the existing connection journey. Publish, trigger
activation and run/preview remain distinct explicit effect-bearing actions.

## Backend work

Repository-owned reviewed manifests compatible with catalog versions; reuse 05 instantiation, never a parallel importer. Track template version for provenance without coupling future edits.

### Approved examples and supported environment

All selections below are active/placeable in `validate_activation` serving epoch
38 at the preparation baseline. API and worker default to cohort `core`, which
has only Set@1 and Terminate@1 available for new placement; Manual@1 is retained
but unavailable. These examples are **not** usable in that default cohort.
Only the supported profile is approved for preparation/controlled qualification.
Version/config choices remain pinned; no silent replacement with “latest”.

| Example | Pinned nodes | Input, setup and effect contract |
| --- | --- | --- |
| Webhook validation and routing | Webhook@1, Validate@1, Condition@1, Set/Terminate@1; configVersion 1 | Check a required string `type` equal to `notification`. Validate emits `{valid,issues,truncated}`, not the submitted payload; map `$.valid` into Condition's boolean input and use `true`/`false` branches. Original data needs a separate run-input mapping. Endpoint/signing state is separately materialized after explicit publishing/activation; no synchronous webhook response promise. |
| Scheduled bounded demo batch | Schedule@3/configVersion 3, ForEach@1 and Set@1/configVersion 1 | An hourly interval with skip misfires supplies a trigger envelope, not batch data. Use exactly two literal demo items, `maxIterations:3`, `maxConcurrency:1`, and nearest-item/ordinal structured mappings. ForEach's input ceiling is 1,000 items; the example is not a retrieval connector or unbounded batch service. Publishing/activation can create future schedule effects. |
| Controlled HTTP and conditional Slack notification | Active Webhook@1 root, HTTP Request@1, Condition@1, Slack Send Message@1; configVersion 1 | Explicit controlled endpoint, webhook input and destination Slack channel. Required slots are `http_headers` (provider/auth `http`/`http_headers`) and `slack_bot_token` (`slack`/`slack_bot_token`). Successful HTTP output contains only 2xx statuses; non-2xx does not reach the success Condition and follows existing failure/outcome-unknown policy. Response JSON is not automatically parsed. Disclose HTTP/Slack external effects and unsafe retry semantics. |

The webhook prototype accepts request body `{"type":"notification"}`. Its
Validate payload mapping wraps run input as `{"payload":{"type":"notification"}}`,
so the actual validation rule is `$.payload.type`; the request itself is not
wrapped. The third template's guided literals are HTTP `config.url` and Slack
`inputMappings.channelId.value` with unchanged `kind: literal`, not Slack config.

Config-schema parsing and F05 portable-policy exact-preservation were checked
for nine selected node configurations using existing same-baseline built
artifacts. That initial proof was config-only. After product approval, three
complete external prototypes passed actual selected-catalog placement, bounded
authoring validation, F05 inspection/reprojection and engine compilation at
`169b776`. Expanded invocation bounds are 5/6/6; the schedule worst-case loop
bound is 3 for two literal items. IDs, expressions, mappings and config survive
binding/reprojection exactly. Default-core and missing/wrong-slot binding
rejections pass. HTTP status and webhook routing samples use pure policy, not
provider execution; provider/auth metadata checks are synthetic, not real
database preview. Placeholder `example.test` URLs and example channels are not
usable destinations. Prototype manifests, digests, reproducible proof and
limitations are retained in external `pertexo-f06-2026-10-02/graph-feasibility`
evidence, not shipped runtime assets. No provider calls were made.

### Provenance decision: separate origin from an editable copy

The current strict F05 manifest/import schema has no template-origin extension.
Do not hide origin in the workflow name, graph labels/settings, browser storage
or undocumented extra manifest fields. A template's asset version is immutable;
the resulting workflow graph is freely editable and is not synchronized or
overwritten when an asset changes.

- **Accepted durable option:** under accepted ADR063/contract,
  add bounded optional origin metadata to the existing atomic import command and
  scoped workflow reads. Define template ID/version, base-manifest digest and
  allowed setup transformations. The server verifies a reviewed repository
  descriptor before recording origin; a client string alone is not trusted
  provenance. Include origin in the frozen idempotent request identity and
  persist it in the same transaction as creation, never a second browser write.
  Preserve F05 requests without origin and retained command readers/replay.
  Define authorized reads, whether duplication carries origin, and absence of
  origin on ordinary portable export/import explicitly in that ADR. Keep
  provenance as historical origin, never proof that the current graph still
  matches or is safe. This needs API/database work, but not a template-listing
  backend or user-managed registry.
- **Rejected smaller assets-only option:** immutable reviewed assets plus existing F05
  creation without new durable fields. Clearly state that origin is not retained
  across restart/export/edit; defer the provenance acceptance and removal/read
  promise below. Do not label session-only setup information durable provenance.

The durable option requires additive readers/schema before writers, bounded
retained descriptor compatibility when examples disappear from the chooser,
and workflow/workspace retention/purge rules before enablement. Membership loss
must stop disclosure without deleting other members' workflow origin. A rollback
must disable new template selection/writes while preserving ordinary import and
accepted exact-replay/read behavior. The next free ADR was checked against the
local ADR inventory and all Git refs; ADR063 and its concrete contract are now
accepted. Descriptor/origin schema, opt-in read, inheritance/export and strict
held-traffic compatible-reader rollback require implementation and owned proof.

## Delivery slices

1. Approved product choices and accepted ADR063/concrete contract are recorded
   before persistent implementation. Integrate F05 repairs by
   additive normal merge/cherry-pick only, preserving snapshot/local work.
2. Author reviewed pinned assets and compile each completed graph through normal
   selected-catalog admission/F05 preview. Cover mappings, bounds, required
   bindings, default-core rejection and immutable descriptor compatibility.
3. Deliver chooser and guided setup on the existing recovered import command;
   independently editable, unpublished draft with no execution side effects.
   Provenance ships atomically with its readers/rollback tests.
4. Qualify the controlled integrated journeys below and record exact source,
   serving profile, fixture ownership and limitations before release review.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Every approved template creates a valid independent draft preserving graph-local
IDs and expression text exactly, with explicit destination bindings, no secret
or cross-workspace source identifiers, and no publish/run/trigger activation.
Unavailable definitions, removed/incompatible versions and missing/wrong bindings
fail clearly before creation. A new template asset does not mutate an existing
workflow; removing it from selection preserves approved retained provenance and
read/replay compatibility; assets-only deferral is not the approved scope.

Required controlled proof:

- Webhook valid/invalid/missing inputs select the expected branch through the
  existing real trigger/API/queue/worker path; no synchronous response semantics.
- Schedule uses a valid trigger envelope and processes exactly the two literal
  items under the declared bounds, including empty-batch and out-of-bound input
  behavior.
- Controlled HTTP 200/204 select opposite branches; non-2xx takes the existing
  failure/outcome-unknown path. Only the intended successful branch invokes an owned Slack
  transport seam. Use owned synthetic transports, not real Slack/public HTTP,
  production credentials or a weakened SSRF/network policy. Label those limits.
- Real browser + owned API/PostgreSQL: choose/configure/preview/create/open/edit
  independently; zero executions/triggers created by import. Lost response,
  held request + dismissal/reopen, duplicate click, scope/authority loss and late
  response reuse one exact command or clear it safely. For approved provenance,
  cover transactional persistence, restart, retained replay after writer rollback,
  authorized reads and retention/purge alongside old F05 clients.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Marketplace, public submissions, ratings, template monetization and automatically executing examples.

## Rollout and rollback

Remove a template from new selection without changing existing user drafts; retain provenance.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

Make's blueprints show why reuse accelerates setup; curated examples are the smaller initial product than a marketplace. Sources: [Make blueprints](https://help.make.com/blueprints).

Research checked 2026-09-28; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation or billing policy.

## Delivery tracker

- [x] Baseline reconciled against current code and accepted decisions.
- [x] Audience/examples, guided binding and durable historical provenance selected.
- [x] Necessary persistent ADR accepted after primary and independent review.
- [x] Contracts and failure/security model reviewed.
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [ ] Real integrated acceptance evidence recorded.
- [ ] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

Evidence log: 2026-10-02 read-only preparation at F05 candidate `a0d69f57`:
accepted ADR060/062, strict F05 HTTP schemas, API/worker cohort configuration,
catalog registry and selected node definitions inspected; nine config-schema
and portable-policy checks passed as described above. Subsequent manager approval
and three complete normal-admission graph prototypes are recorded above. Manager
acceptance of ADR063/contract follows primary and independent review, including
strict held-traffic new-head/helper inventory compatibility, bounded browser-safe
Slack input/HTTP UTF-8 validation and confined descriptor lock privileges.
No chooser, persistent
provenance, real API/database preview or live journey exists from this preparation.
Baseline/product-choice and ADR/contract review rows are complete; implementation,
owned qualification and release gates remain open. No runtime or image qualification
is implied by design acceptance.
