# F06 — Template-origin contract and failure design

Status: accepted by the roadmap manager after primary and independent review,
2026-10-02. Implementation authorized; release and owned qualification remain open.
Parent: [F06](06-curated-templates.md), accepted
[ADR063](../adr/063-curated-template-historical-origin.md).

## Source and approved scope

Original preparation snapshot: `a0d69f57`. F05 recovery `169b776` integrated by
normal fast-forward, preserving the three uncommitted preparation documents.
Confirmed-reset follow-up `ba997c39` is now also integrated by normal fast-forward;
no history rewrite or mutation of the original snapshot. Existing
ADR060/062 and the unchanged F05 contracts remain authoritative except for the
explicit additive changes accepted in ADR063.

Manager approved audience/examples, `validate_activation` only, explicit binding
before creation and durable historical provenance. The API/database design here
is accepted after closure of both review clarifications. No migration number is allocated before
manager reconciliation of combined F02/F05 release history.

## Exact additive wire changes

| Surface | Proposed behavior | Old F05 compatibility |
| --- | --- | --- |
| Import preview | Optional strict `templateOrigin` alongside manifest/bindings; descriptor/delta findings use bounded sanitized issues. Successful preview means only advisory current compatibility, not execution safety. | Absence uses unchanged request/response, limits and policy. |
| Import create | Same optional origin plus existing name/fingerprint; unchanged CSRF/idempotency headers, 2 MiB total raw request ceiling and `{workflowId}`/201 Location response. | No origin means byte-identical canonical command/hash and result shape. No `null`, extra fields or format V2. |
| Existing scoped workflow GET | Optional exact query `include=templateOrigin`; explicit `{workflow: existingSummary, templateOrigin: OriginV1|null}` response, no-store. Reject unsupported include values normally. | Default GET and every list/command response remain exact old shapes. Old clients never opt in. New client cannot treat missing field/unsupported projection as authoritative null. |
| Export/duplicate | Export excludes origin. Existing duplicate atomically inherits origin with `derivation: inherited`, without changing request identity or identifier-only result. | Old duplicate receipts replay without consulting new metadata. Old no-origin sources still copy normally. |

OriginV1 is strict, bounded to 512 canonical UTF-8 bytes: `schemaVersion:1`,
ASCII kebab-case `templateId` (1–64), positive int32 `templateVersion`,
`baseManifestDigest`, `creationCommandDigest` (64 lowercase hex each) and
`derivation: direct|inherited`. No label, free-text setup, actor, connection,
workspace, source-workflow ID or timestamp is necessary in this record. Creation
timestamps remain on the workflow. Request origin omits the two server-derived
fields; a client supplying them is invalid. The total envelope ceiling, depth,
node/edge/slot/issue bounds and duplicate-key rejection are unchanged.

## Reviewed descriptor and delta verification

First registry is three owner-installed ID/version entries, each bounded by the
existing 2 MiB manifest limit. A descriptor contains the pinned F05 manifest,
base canonical digest, descriptor schemaVersion 1 and at most 16 unique typed
setup targets `{nodeId, location, key, valueKind}` (IDs 1–64, keys 1–64, no JSON
Pointer). Location is `config` or `literalInput`; initial targets are precisely
HTTP `config.url` and Slack literal `inputMappings.channelId.value`. The latter
retains its mapping's exact `kind: literal` and other shape; it is not a config
property. Allowed value kinds are bounded HTTPS endpoint and Slack channel ID.
HTTP URL is at most 2,048 **UTF-8 bytes**, not characters, and must satisfy the
registered HTTP config URL rule: a valid HTTPS URL, no username/password, no
fragment, and no decoded query parameter name matching
`/(?:auth|credential|secret|token|api[-_]?key)/iu`. Slack channel is 2–128 ASCII
characters matching `^[CDGU][A-Z0-9]+$`: the intersection of the registered
Slack input rule (2–255) with the tighter template bound. Existing secret-content
policy still applies. Bounds are intersections, not weaker substitutes.
The first two examples have no editable config target; name/bindings are external
to manifest setup. Retiring selection never edits descriptor content.

The browser-safe workflow-model module exposes one bounded, pure typed
setup-validation interface for these descriptor value kinds, returning sanitized
findings without normalization or network effects. Chooser and server origin
verification use it; server admission additionally checks the submitted value
against the registered HTTP **config** or Slack **input** rule, respectively.
F05 `platformPortableDefinitionPolicy` validates registered config only; it does
not validate Slack literal input mappings. Do not import server-only node-catalog
or integrations into the browser model. Differential server-side tests compare
the browser-safe validator with the registered rules plus template bounds,
including Slack prefixes/case/length 1, 2, 128, 129 and HTTP 2,048/2,049-byte
multibyte boundaries, invalid URLs, userinfo, fragments and encoded/case-varied
credential query names. The SQL typed-delta guard must reject the same disallowed
target values; no tier may treat config-only F05 inspection as input validation.

Verification is exact, not fuzzy graph matching:

1. Resolve `(templateId, version)` from the owner-installed registry; check exact
   base digest and supported descriptor version. No remote asset fetch.
2. Start with the submitted configured manifest. For each reviewed typed target,
   locate the unique graph node through graph structure, validate its submitted
   target literal, and restore only that config property or literal-input value
   to its descriptor base value in a comparison copy. No traversal into arbitrary
   literal data or mutation of mapping kind/expression text.
3. Compare the whole restored manifest structurally/canonically to the reviewed
   base. All IDs, ordering, positions, nested scope/body structure, definitions,
   config versions, requirements, slots, settings, edge/reference/mapping shape
   and expression text must match. Only the explicitly permitted literal values
   differ in the admitted configured manifest. Missing/extra targets, nodes or
   properties fail.
   Base `connectionRefs` are empty; explicit bindings are independently checked.
4. Use the verified full canonical command hash as the persisted creation-command
   digest (already matched to the locked claim by the SQL helper). Run normal F05 portable
   inspection, placeable-node checks, authoring admission and connection checks.
   Reject stale serving fingerprint at create. Never replace versions/cohorts.

Descriptor entries are generated from reviewed repository assets into a
schema/readiness-checked owner installation artifact. The same graph is not
handwritten twice. Canonical bytes, manifest digest, allowed target set and
selection cohort are covered by golden/differential tests. SQL guard verifies
the descriptor and typed literal-only delta as well as its F05 command/claim checks;
API does not pass a trusted-origin boolean or permit runtime registry writes.
Unknown/removed/mismatched origin returns sanitized validation/conflict detail,
never uploaded literals or graph/config text in logs or issue messages.

## Persistence, authorization and lock model

New relations: immutable owner-installed `curated_template_descriptors`
with selection-enabled flag, and tenant `workflow_template_origins` child row.
Use existing PostgreSQL types/UUID/composite tenant keys,
not vendor-specific architecture or a changed identifier policy. The origin FK
references workflow `(workspace_id,id)` with cascade; no descriptor FK is needed
for retained reads, and no runtime resource depends on a current selection row.
No new index other than unique descriptor identity and origin primary/FK key.
Origin uses existing workspace RLS/context checks; API has no direct origin
INSERT/UPDATE/DELETE. Confined import/duplicate helpers insert bounded records;
ordinary scoped reads use explicit selection, preserving old `select *` schemas.

Descriptor `FOR SHARE` requires lock-support privileges, not just SELECT.
Use a confined owner-owned security-definer read-lock helper, callable only
by the API runtime role (PUBLIC revoked), with strict bounded descriptor identity,
fixed `search_path=pg_catalog,pg_temp`, schema-qualified objects and
`row_security=on`. It locks/returns only the requested descriptor in the caller's
transaction after existing authority checks, at the descriptor position below;
it performs no content or flag mutation. Pin its body, owner, settings and ACL
in readiness. API receives no descriptor UPDATE/INSERT/DELETE grant. Negative
runtime-role tests must prove direct content/selection mutation and unauthorized
helper execution remain forbidden; owner selection updates must block against
the held SHARE lock. Do not grant general UPDATE merely to enable row locking.

| Operation | Lock/order and authority | Failure/recovery |
| --- | --- | --- |
| New template import | Existing workspace admission → active actor/membership and workflow-create (+ connection-read when bindings exist) → actor-scoped receipt UPDATE → existing import gate SHARE → template writer gate SHARE → descriptor SHARE → serving catalog SHARE → sorted destination connections SHARE → atomic workflow/draft/origin/audit/receipt. API and SQL helper obey the same order. | Any failure rolls back everything, including claim and origin. No partial draft/origin attachment. Descriptor retirement, writer-disable or catalog change winning first rejects new creation. |
| Exact retained replay | Existing current authority → receipt UPDATE → original destination SHARE. | Return identifier before new gate, descriptor/catalog/binding checks. Same key/different origin/config conflicts. Missing destination fails closed. Expired/reaped receipt means a new command under existing F05 rules; do not auto-create a replacement. |
| Preview | Current creating authority; read current descriptor/catalog and validate bindings using existing preview transaction. | Advisory only. Create repeats checks under locks; preview cannot reserve a connection, descriptor or future execution. |
| Origin read | Same workflow-read and tenant visibility as existing summary; summary and child origin in one read transaction. No descriptor lookup needed. | Current membership loss denies immediately; missing workflow follows existing not-found disclosure. Lack of projection support is unavailable, not origin-null. |
| Duplicate | Existing source workflow UPDATE/draft or retained-version locks and existing receipt protocol. Read/copy origin under the source lock and commit with the new draft. | Copy direct or inherited basis as inherited; retain original digests, no lineage IDs. Existing replay/rollback semantics unchanged. No template writer gate/descriptor validation on copy. |

Global owner changes to gate/descriptor flags acquire only their own global locks;
they must not acquire tenant/workflow resources afterward. Purge retains existing
workspace/resource order; receipt reaper uses existing skip-locked terminal
protocol, not new descriptor locks. Do not add advisory/hold locks to import.
Prove flag/import, catalog/import, connection/import, member-removal and
same/different-request key races on real PostgreSQL before enablement.

The existing helper's exact top-level command allowlist must accept only its old
four fields or those four plus `templateOrigin`. Preserve its signature and
old byte identity; origin-aware branch verifies descriptor/delta, normal F05
binding materialization and child-row creation. Keep old guards available when
writer flag is off. Duplicate helper compatibility must copy child metadata even
when served by the separately built, qualified compatibility image defined below;
an unmodified older image is not migration-compatible.

## Retention, rollback and release

Origin follows workflow lifetime. Rename/edit/publish/version restore/archive do
not erase or recalculate it. Membership removal stops access but preserves shared
metadata. Workflow/workspace purge cascades child rows only when existing legal
hold/retention rules actually permit parent deletion. Receipts retain only their
existing actor/hash/identifier result and 24-hour terminal expiry/hold behavior;
new origin does not extend receipt retention or deduplication. Descriptor assets
contain public instructional content only, never private setup values. Retired
versions remain in the owner registry; no new descriptor GC product is proposed.

Readiness remains strict: `readiness-probe.ts` requires the exact migration head,
and `readiness-workflow-duplication.sql.ts` / portability equivalent pin helper
body hashes. Replacing helpers or advancing the head therefore rejects unmodified
old images, even when their default read/duplicate code would otherwise work.
No widening of the head check, bypass of helper inventory or readiness relaxation
is permitted. An **older compatibility image** means a separately built and
qualified image accepting the new exact migration head and helper inventory,
retaining old default read/duplication code where applicable but including
origin-aware request parsing/replay and the retained origin reader.

Rollout order (held-traffic migration-head cutover, no unmodified old-image overlap):

1. ADR/design accepted after primary and independent review. Allocate an additive
   migration only against the manager's reconciled F02/F05 migration history.
2. Hold/drain traffic before installing owner descriptor/origin schema,
   RLS/grants, compatible import/duplicate guards and readiness inventory.
   Both writer gates remain off; no unmodified old image serves the new head.
3. Deploy and qualify the compatible API/contracts image against the exact new
   head/helper inventory before releasing held traffic. Keep origin-aware
   chooser/writer off. Test old strict row readers/default summaries and duplicate
   code on that image; no `app.workflows` column added. Golden old hashes/receipts,
   missing registry/readiness and unknown-version failures must pass.
4. Qualify normal graph admission and all controlled local journeys on an owned
   supported profile. Enable only local reviewed selection/template writer after
   complete evidence and explicit environment approval; never change defaultcore.
5. Rollback disables chooser/new template writes first. Keep schema, retained
   descriptors/origin, upgraded helpers/replay and default/opt-in reads.
   Origin-aware **new** submissions may stop, but retained origin-bearing replay
   must still be served by the qualified compatible reader/parser image.
   Pre-origin parser images are not supported import-endpoint rollback targets
   after any origin command has been accepted. Old F05 clients/default reads
   remain usable on the compatible image. No destructive down migration or
   image that reapplies an incompatible helper may be deployed.

Required owned-local cutover matrix (implementation tests, not completed evidence):

| Transition | Required proof |
| --- | --- |
| Stop/hold traffic → migrate, writers off | Drained old image cannot receive traffic; unmodified old image fails readiness at the new head/helper hashes. Failed migration leaves traffic held. |
| New head → deploy compatible/off → release held traffic | Exact head, helper bodies/settings/ACLs and origin reader readiness pass; missing/mismatched inventory fails closed. Old strict default reads, retained ordinary replay and origin-inheriting duplication work; ordinary new import still obeys its existing F05 gate. No template creation while off. |
| Compatible/off → enable reviewed local writer | Same qualified image/inventory; only explicitly approved owned supported profile. Direct origin creation/read, typed validation and retained replay pass. |
| Enabled → disable new template writes → rollback compatible/off | Rebuilt/qualified compatibility image remains ready at the new head; old default reads/duplicate code, origin read/inheritance and retained origin-bearing replay still work, including after restart/selection removal. Pre-origin-parser image is rejected as a rollback target after acceptance. |

No production migration, traffic hold/cutover or enablement is authorized here.

Readiness separately attests origin reader and new template writer availability;
writer-off must not imply reader-off. Browser setup/command state is ephemeral,
identity/workspace scoped and explicitly clears on loss; no localStorage/global
store. Query keys distinguish the opt-in projection but remain under the same
existing scoped cancellation/invalidation prefix. Ongoing graph edits do not
pollute origin cache with inferred safety or similarity state.

## Review and acceptance checklist

- [x] Primary and independent ADR/contract review; concrete schema/helper/readiness
      rollout and compatible rollback design accepted before persistent code.
      Actual images and runtime cutover qualification remain open below.
- [x] Three completed external prototype graphs admitted/compiled under pinned supported profile;
      defaultcore rejection and exact IDs/dynamic text preservation proved.
- [ ] Descriptor digest/target-delta verification tested against missing/extra
      config/target/node/nested graph, origin forgery, null/unknown members,
      secret-bearing setup and mutation bounds in model/API/SQL guard.
- [ ] Browser-safe typed setup validation differentially matches registered HTTP
      config and Slack input rules intersected with template bounds; descriptor
      read-lock privileges forbid runtime content/flag mutation.
- [ ] Held-traffic cutover matrix proves strict new-head/helper readiness,
      no unmodified old-image overlap and separately qualified compatible rollback.
- [ ] Old canonical hashes/requests/default reads/export bytes and old exact
      receipts preserved; origin-present mismatch conflicts; removed selection
      and disabled-writer retained replay works after restart.
- [ ] Each-write rollback, duplicate origin inheritance, graph edit/version
      restoration independence, membership and real PostgreSQL race/RLS tests.
- [ ] Hold/deletion/purge child metadata and receipt expiry/reaping exercised;
      current origin read remains possible after selection removal.
- [ ] Owned browser/API/PostgreSQL/queue/worker runs for the bounded examples;
      synthetic controlled HTTP/Slack transports labeled, no public/provider
      effects or network-policy weakening. Mock-only proof does not close this.
- [ ] Exact-source gates/receipts, combined migration history, manager release
      review, hosted checks and natural-main follow-up recorded before release.

Separate external graph-admission proof at `169b776` now covers all three
complete prototypes through actual placement, authoring validator, F05 portable
policy and engine compilation, including default-core/binding rejections and
exact recursive preservation. It uses synthetic bindings/provider metadata and
pure input/outcome samples, not authentic API/DB preview, coordinator execution
or provider delivery. See external `pertexo-f06-2026-10-02/graph-feasibility`.
No schema, persistent origin write/read, registry, runtime chooser, provider call
or production rollout has been implemented by this design.
