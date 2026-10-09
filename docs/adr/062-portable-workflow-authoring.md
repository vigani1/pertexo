# ADR 062: Portable authoring graphs with explicit destination connections

- **Status:** accepted; implementation authorized, production activation unauthorized; superseded in part by [ADR 069](069-architecture-reset.md) (no rollout switch or SQL re-validation of imports)
- **Date:** 2026-10-01
- **Baseline:** fetched main `228a692dda5f67e7256be88ff496c8810ddc36f9`

## Decision

F05's next usable slice exports a reviewed saved draft or explicitly selected
retained version as a bounded Pertexo authoring manifest, then imports it into a
new unpublished workflow after compatibility preview and explicit destination
connection selection. Preserve graph-local identity and expressions; replace
only typed connection references. Never export credential bytes, executable
envelopes, operational state or source resource metadata. Literal content is
not intrinsically non-secret: require explicit content review and refuse known
credential-bearing shapes rather than silently exporting or rewriting them.

The manager accepted reviewed literal-content export and authorized the cohesive
vertical slice on 2026-10-01, after independent Standards/Spec reviews reported
zero findings on `228a692d...d8ddc152`. No further product choice is pending.
Implementation and qualification remain separate from this decision.
ADR061 is reserved by the concurrent input-case delivery; this is the next free
number after that reviewed decision, despite its absence from this main baseline.

## Current-source reconciliation

- [ADR060](060-workflow-duplication-identity.md) governs same-workspace copies.
  [Duplication persistence](../../packages/database/src/authoring/workflow-authoring-duplication.ts)
  preserves IDs and dynamic JSONata; it did not introduce a remapper. Import
  creates a different workflow, so preserving IDs avoids breaking dynamic
  `$lookup(nodeOutputs, runInput.stepId)` references without runtime aliases.
- [Graph contract](../../packages/workflow-model/src/graph-contract.ts),
  [draft preflight](../../packages/workflow-model/src/graph/preflight.ts) and
  [placement](../../packages/workflow-model/src/graph/definition-placement.ts)
  own bounded graph parsing and new-placement semantics. Import compares with
  the empty destination, never with the source's grandfathered definitions.
- [Catalog resolution](../../packages/node-catalog/src/definition-resolution.ts)
  owns registered schemas and connection requirements. Neither it nor generic
  graph config/literal records declares arbitrary text secret-safe. HTTP config
  already rejects credential-bearing headers and query names in
  [validation](../../packages/integrations/src/http-request/validation.ts).
- [Authoring draft store](../../packages/database/src/authoring/workflow-authoring-drafts.ts)
  and [duplication migration](../../packages/database/migrations/0129_workflow_duplication.sql)
  supply creation/receipt patterns, not an import command to call in a second
  transaction. Current authoring creation has no workflow-count entitlement;
  execution/artifact quotas are different policies, not import limits.
- Existing HTTP owner is
  [workflow-authoring contracts](../../packages/contracts/src/workflow-authoring.ts)
  and [application persistence interface](../../apps/api/src/workflow-authoring/ports.ts).
  Web owners are workflows dialogs/commands, editor draft authority and version
  history; no new package, global store or portability framework is needed.

## Source and disclosure

Offer saved draft by default and an explicitly selected immutable version in
version history. Never export unsaved browser state. Resolve dirty/in-flight/
conflicted editor state before draft export. Read authority in an active
workspace is required; export does not require create or run authority.

The user reviews the exact authenticated source representation, including
configs, literal mappings, expressions and labels. Download is initially
disabled until an explicit acknowledgement: content may contain private values,
no arbitrary-secret detector exists, and connection credentials are excluded.
Bind acknowledgement to a domain-separated canonical graph digest. The export
request carries the source selector and reviewed digest, not browser graph data.
Draft export additionally requires its existing strong If-Match; the server
rechecks tag/digest on the locked source snapshot. A changed source requires a
fresh review, never an automatic download of newer content. Version selection
is workspace/workflow/version scoped, not substituted with current publication.

Export preserves allowed config values exactly after registered schema checks.
Reject unknown definitions, unsupported config versions/fields and invalid
provider configuration, including configured auth headers/credential URLs.
Additionally refuse credential-like property names in config and literal JSON
objects, using a documented conservative policy matching auth, credential,
secret, token and API-key names; bounded diagnostics identify paths, not values.
False positives require an authoring change, not a bypass or silent deletion.
Do not scan/rewrite expression strings or pretend this catches private values
under innocuous keys. Explicit literal-content review is still mandatory.

The accepted security/product tradeoff permits deliberately reviewed literal
content with fail-closed known credential checks. It does not assert that all
arbitrary literals are automatically safe. No secret-store access is needed.

## Manifest v1 and identity

Use strict JSON with `format: "pertexo.workflow"`, `formatVersion: 1`,
`graph`, `requirements` and `connectionSlots`. No source workspace/workflow/
version/actor/connection IDs, source names, timestamps, run/test-case payloads,
checksums of executions, trigger registrations, notification settings, health,
pause/concurrency state or executable envelopes appear in the file. Graph-local
IDs remain content, not tenant resource identifiers. Do not claim arbitrary
user-authored strings cannot contain an ID or private information.

`graph` uses the existing graph-v1 grammar, with every node's connectionRefs
empty, including nested bodies. `requirements` contains the exact sorted unique
definition identities/config versions and a server-derived
`node-select:v1:sha256` compatibility-selection fingerprint. Reuse node-sdk's
selection projection rather than inventing execution pins or exposing executor
documents. Export represents authoring content under the selected serving
catalog, not a promise to reproduce the source version's historical execution.

Each connection slot declares graph node ID, definition-declared slot name,
provider key and auth type from reviewed catalog policy. Use node ID plus slot
name as its unique identity; do not invent IDs or preserve source account-sharing
groups. One declaration per required occurrence, including missing source
bindings. Unknown/extra connectionRefs fail closed. Slot declarations are
validated against the graph and catalog, not trusted as credential policy.
Import must bind every required slot to an explicitly selected destination
connection; no name matching, implicit reuse even in the same workspace, or
cross-workspace credential copy. Selecting the same destination connection for
multiple slots remains explicit and allowed.

Preserve node/edge IDs, nested graphs/ports, mappings, expressions, positions,
labels, disabled flags and graph settings exactly except typed connectionRefs.
Do not rewrite strings, typed node_output IDs, dynamic JSONata or literal input
values. Graph admission rejects duplicate/dangling identities; imported nodes
never coexist with existing nodes in the same destination workflow. This
separately resolves F05's earlier generic remapping suggestion for imports;
canvas node duplication remains unchanged.

## Bounds and compatibility preview

Manifest/file and import request each have a 2,097,152-byte UTF-8 ceiling;
existing graph ceiling remains 1,048,576 bytes, aggregate 1,000 nodes/4,000
edges, structured depth 32, config/literal JSON depth 64 and input depth 256.
Requirements and connection slots each have at most 1,000 entries; current
provider definitions require one slot per node. Reject larger future slot
shapes until the format is revised deliberately. Destination name remains
trimmed 1–128 characters. Both envelope and graph budgets apply; some graphs
at the graph ceiling may exceed the portable envelope ceiling.

Check raw size before JSON parsing; reject duplicate object keys, unknown fields,
non-JSON/prototype/accessor/cyclic inputs, unsupported format/schema versions and
excessive depth before recursive schema work. Apply route-specific limits,
without enlarging unrelated API limits. Cap public diagnostics at 100, with
explicit truncation; never reflect raw literal/config/expression content.

Dry run is authenticated, side-effect free and unpersisted. Derive exact required
definitions from graph, validate requirement equality and serving selection
fingerprint, and apply normal graph/config/expression admission and placement.
No latest-version substitution, migration, missing-definition dropping,
evaluation, execution, network URL fetching or provider validation occurs.
Unknown/non-placeable/incompatible definitions block creation. Registered config
validation must not silently transform the graph. Publish-blocking draft issues
are shown using existing validation distinctions; hard malformed/reference/
security failures block import. All slots must be bound before create.

Preview is advisory, not authority. It returns bounded issues, slots, manifest
digest and destination catalog fingerprint; no preview token or server-stored
upload. Any file/binding/name edit invalidates preview locally. Creation binds
the displayed catalog fingerprint and reruns authoritative checks; catalog
change returns explicit conflict and requires another preview/confirmation.

## HTTP and atomic import

Existing authoring routes: POST workflow `/:workflowId/export` with
source/reviewed digest (draft If-Match); POST workspace `/workflows/import/preview`
with manifest and chosen bindings; POST `/workflows/import` with name, exact
manifest/bindings and expected catalog fingerprint. All POSTs require session/
CSRF; reads use workflow:read, preview/import require workflow:create and
connection-read authority where relevant. Reject foreign connection references
without revealing existence. Download is JSON, no durable server file.
Responses are private/no-store; use a fixed safe download filename, not source
metadata. Request bodies and manifest content are excluded from logs/audit.
The browser checks bytes before parsing local files and treats content as
untrusted data, never HTML or instructions. A digest is content identity, not
authenticity or authorization. Before create, explain that later publish/run
can have real effects; importing the file itself has none.

Import uses distinct `workflow.import` receipt scope workspace + actor, requiring
the existing bounded Idempotency-Key. Hash the canonical exact manifest, normalized
name, bindings and original expected fingerprint. Never hash a later catalog
projection instead of the submitted command. Generate destination ID server-side.

One tenant transaction rechecks active actor/membership/workspace authority,
serializes the durable receipt claim, and locks the selected serving catalog and
destination connections in deterministic ID order. For a new claim, verify
catalog CAS, graph/slot compatibility and current destination connection
ownership, provider/auth type and usable status before any workflow writes.
Membership/catalog/connection mutation races must have explicit lock winners.
No preview read or client digest grants authority. Preserve existing bounded
off-thread admission and transaction timeout contract.

Create exactly one normal-default workflow and revision-1 draft, safe audit fact
and completed identifier-only receipt atomically. Use one least-privileged
additive creation function if existing grants require it; never create then save
through public methods in separate transactions. Return 201 `{ workflowId }`
and safe Location; load the authorized destination representation separately.

For exact replay, recheck current actor/membership/workspace and destination
visibility, then return the original destination before comparing changed
catalog/connection health. A revoked connection after a successful import must
not manufacture a second workflow or prevent discovering the accepted result.
Changed request with same key conflicts; missing destination fails closed, not
recreation. No source-workspace access is required to import a reviewed file.

After uncertain response, retain exact manifest/name/bindings/fingerprint/key in
scoped memory for explicit retry only; do not rebase, automatically POST, persist
to localStorage or navigate speculatively. A known confirmed destination can be
opened without another POST. Session/workspace/authority loss clears sensitive
state, aborts reads and fences late results; conflicts retain editable intent.

## Capacity, retention and rollout

### Ordered locks and race winners

Portability transactions enter normal tenant context, then explicitly acquire
`app.lock_workspace_run_admission(workspace)` (workspace SHARE), actor user SHARE,
and actor membership SHARE in separate statements, before checking active status
and role. Never use a joined authority SELECT to establish lock order. This is
workspace-first like connection management and existing-member commands
(`identity-workspace-member-command.ts` takes workspace UPDATE, sorted users,
then memberships). Membership/lifecycle/deletion writers that win the workspace
lock first invalidate later commands; admitted commands finish before those
writers can change authority. No connection, claim or catalog lock precedes the
workspace lock.

| Operation | Ordered locks after authority | Race winner / outcome |
| --- | --- | --- |
| Export draft | Source workflow SHARE → draft SHARE → serving catalog SHARE | Save winning draft UPDATE makes old tag/digest fail; export winning SHARE yields exactly reviewed content. Lifecycle winning workflow UPDATE makes source unavailable. Publication follows workflow before draft; shared catalog locks do not invert its order. |
| Export version | Source workflow SHARE → selected immutable version SHARE → serving catalog SHARE | No source substitution; workspace purge waits for admission workspace SHARE, immutable source remains scoped. |
| Import new | Exact actor-scoped receipt UPDATE → writer gate SHARE → catalog-current SHARE → destination connections SHARE in sorted ID order → create destination/draft/audit → complete receipt | First same-key transaction commits one result; different input conflicts. Gate/catalog writer winning first rejects stale/off admission. Connection revoke/rotate/health UPDATE winning first makes new binding fail if unusable; import winning SHARE commits its explicit binding before later health change. |
| Import replay | Exact actor-scoped receipt UPDATE → original destination SHARE | Return accepted identity before gate/catalog/binding checks. Missing destination fails closed; authority loss never replays. |
| Preview | Catalog-current SHARE → destination connections SHARE in sorted ID order | Snapshot is advisory; create repeats checks and binds displayed fingerprint. No claim, workflow, audit or upload write. |

Connection management acquires workspace admission before authority and
connection UPDATE; health consumption acquires workspace admission before inbox/
observation/connection UPDATE. Portability never locks those inbox/observation
rows. Catalog activation only locks catalog authority and does not acquire a
tenant/connection lock afterward. Writer-gate changes must likewise take only
the gate row, not acquire a workspace after it. Use connection SHARE, not KEY
SHARE: non-key health/status updates must conflict.

The transient receipt reaper selects only expired completed records with
`FOR UPDATE SKIP LOCKED`, excluding legal-held workspaces; it never waits for an
import's locked claim, then acquires a tenant resource. A reaped receipt starts
a new command; a still-retained exact receipt discovers its original result.
Workspace purge locks its job/step and workspace before tenant rows; the import
workspace SHARE blocks purge admission, so claim/destination locks cannot form
a reverse edge. Legal-hold projection uses its existing advisory/workspace
protocol; portability takes no hold/advisory lock and never destroys data.
Membership removal immediately fences replay; receipts retain only actor scope,
hashes and destination identity under existing terminal retention/legal-hold
policy, not raw authoring data. Workspace erasure already includes the generic
idempotency table; new actor-only import scope needs no source-resource cleanup
or extra tenant table. Prove these claims with enabled race/retention/purge tests.

No new commercial or workflow-count quota is introduced. Reuse existing
authenticated transport/rate admission and server graph/file limits; successful
import does not reserve run/artifact capacity. Defaults are normal new-workflow
defaults, without publication/activation/history/overrides. Publish/run remain
separate explicit actions; imports never emit trigger/provider effects.

No persisted upload or preview exists. Imported graph follows normal draft/
workflow retention. Receipt stores digest and identifier-only result, never raw
manifest/graph/key/bindings. Apply existing terminal 24-hour receipt retention,
legal holds, actor membership removal and bounded workspace erasure; prove the
new operation/scope is covered rather than assuming generic deletion works.
After receipt expiry key reuse is a new command, not forever deduplication.

Import writer defaults off behind a durable authoritative gate; export/preview
readers declare availability independently. Apply additive migration/readiness
before enabling locally or in owned CI fixtures. Determine the exact migration
number from then-current main (do not reserve 0130/0131 used by F02). Record
reader/writer and rollback image compatibility, including any required held-
traffic migration-head cutover; do not claim mixed-head overlap without proof.
Rollback disables new imports but permits exact authorized completed replay and
leaves imported workflows/readers usable. No production activation is authorized.

## Delivery and acceptance

After approval, one vertical slice owns schema/projection/admission, atomic DB
command, HTTP and web download/import dialog together. Required independent
proof: nested loops/Parallel/Merge, dynamic JSONata and typed references preserved;
secret-store never read; forbidden shapes/literal-review gate; tampered/duplicate/
deep/oversized manifest; incompatible catalog; foreign/wrong/revoked bindings;
concurrent same/different-key commands; each-write rollback; membership/catalog/
connection races; restart/lost-response replay, disabled-writer replay, receipt
expiry and erasure. Real browser export then import into a second owned workspace,
explicit rebinding, independent edit/publish/core-only run, desktop/mobile and
keyboard/authority-loss recovery must use real HTTP/PostgreSQL/worker evidence.

Ordinary CI must own each enabled integration/browser suite with strict zero-
skip report validation before completion. Evidence binds exact reviewed head;
failed probes stay labeled, mocks stay separate, and hosted/main/production
qualification remain separate gates. No dependency bundles, subworkflows,
templates, competitor import, automatic publish/run or external provider effect.

## Alternatives

Fresh graph-local IDs plus a remapper break dynamic references; aliases/new
expression syntax broaden scope unnecessarily. Raw graph download silently
discloses tenant connection IDs and unreviewed literals. Automatic regex redaction
cannot establish safety and can change semantics. Core-only empty/literal-free
exports reduce disclosure but fail the requested general reuse journey; they
remain a possible narrower product choice if reviewed literal export is rejected.
Server-persisted uploads/preview tokens add retention/recovery state without
being necessary for bounded JSON-file import.
