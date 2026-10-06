# F08 — Durable workflow-call contract proposal

Status: **ACCEPTED design contract supporting ADR065 — 2026-10-02.**
Primary accepted exact `b6c2998d29408b086c289e87058f9c67d2008ff2`, tree
`777b902351dd2a0fee2b067993ede3bc4ab1364c`, after full initial/revised source review
and original independent Standards/Spec review closure. The title/path retains
its proposal history; recommendations below are accepted design directions.
Implementation was subsequently authorized on the release-qualified integrated
F07 base `0b4e0810d405ecb0b222a2e000d363ef4fbd2380`, tree
`27c2362ba58c9eb161335d89a6665200403d8052`, with exclusive migration0136 allocation.
Primary selected strict independent occupancy/fail-fast child admission on
2026-10-02. Primary also selected the same-workspace pins, portable closed-object
descriptors, proposed expansion bounds, configuration-only preview, conservative
membership-revision authority and publication-pinned family deadline directions.
Complete ADR and transaction/privilege design review are accepted; executable
race/privilege/recovery proof is still required. Design baseline: accepted F07
`e7d25e1f85342f10ae0044aadd408d88c49ea993`, tree
`f3a07aea3819c384928dea7dfd7394553ce4aad3`.
Parent: [F08](08-subworkflows.md). Decision text:
[ADR065](../adr/065-durable-parent-child-workflow-calls.md), globally reserved
by the release owner and subsequently accepted on 2026-10-02.

## Product contract and selected occupancy

One same-workspace published workflow invokes an exact published callable version,
waits durably, then receives its bounded typed result. A child is a separate run,
not a copied graph, For Each body, provider HTTP call or recursive worker executor.
V1 excludes fire-and-forget, cross-workspace calls, recursion and dependency import
bundles. A callable child initially uses the existing Manual entry contract; no
second trigger-entry framework or changing ordinary `run_input` semantics.

A waiting parent releases its worker job/lease, **not its workspace or workflow
active slot**. Each child consumes ordinary independent active occupancy and its
child workflow's current cap. Committed reservations count exactly once; they are
not extra capacity. Root admission and ordinary queued overflow stay unchanged.

At one logical call, atomically accept the child **and** obtain an ordinary active
reservation with the existing entitlement, queue-cap and workflow FIFO checks.
If this cannot be done, retain a definite call refusal with **zero accepted child
runs**, no reservation and no child execution outbox. Never leave an unreserved
queued child waiting behind its own parent. Normal fair outbox delivery still
governs when reserved child work reaches workers; reservation is not a start-time
promise or a worker/global-capacity exemption.

Consequences must be visible next to Call Workflow configuration and on failure:

- Workspace cap one cannot execute a nested call because parent and child would
  require two slots. The call fails explicitly; it does not wait for itself.
- Any fully occupied workspace can refuse a child even when its cap exceeds one.
- A full child-workflow cap, an earlier eligible FIFO ticket, a full queued cap,
  or unavailable/suspended current entitlement can also refuse a fresh child.
- A committed child reservation survives a later limit reduction under ADR058;
  its start still follows the existing first-transition order checks.
- No control-path cancellation or deadline delivery needs a new slot, and those
  exemptions never authorize provider/node execution.

Capacity refusal is an ordinary definite Call Workflow node failure with proposed
safe code `workflow.child_capacity_unavailable`, not a provider failure, unknown
effect or transient promise of eventual execution. Existing unhandled-failure
semantics make the parent failed. F09 custom failure routing is not implemented
by F08. V1 has no automatic Call Workflow retry or new child after refusal. An
explicit parent replay is a new execution and may repeat earlier parent effects;
existing replay authority/confirmation and immutable-history rules apply.

## Callable contract, pins and bounded expansion

Recommend a versioned callable declaration stored in the immutable authoring and
executable projections: a bounded portable input schema, bounded result schema,
and one explicit result selector. Validate the input before child admission and
the selected result before a callable run may succeed. Missing/skipped selector
output or invalid result is a definite child failure, not implicit null, the last
node output, or concatenation of every output.

Primary's 2026-10-02 clarification fixes the run-wide scope rule: a root-graph
`node_output` selector must have exactly one matching successful durable
invocation in the child run, bound to its immutable scope/output reference. Zero
matches, including missing/skipped/non-success, or multiple successful scoped
matches is `workflow.child_result_invalid`, including equal-valued matches.
Validate the declared path and result type against that one bounded source;
missing paths remain `workflow.child_result_missing`. Expression-referenced node
outputs obey the same uniqueness rule. No last-value selection, equality-based
deduplication, aggregation or implicit selecting scope is permitted. Existing
per-attempt mapping is unchanged. Reject statically proven ambiguity at
publication without rejecting cases whose unique outcome is decided at runtime.

Use existing bounded JSON values and schema-document projection owners, but do
not mistake `schemaDocumentSchema`'s JSON-object check for a runtime validator.
V1 recommends a versioned portable type descriptor for string, finite number,
integer, boolean, null, bounded array and closed object. Input and result roots
are closed objects, defaulting in the editor to explicit empty object contracts.
An object declares `properties` and a unique `required` subset; undeclared fields
are always rejected. Property names match `[A-Za-z_][A-Za-z0-9_]{0,63}`, excluding
`__proto__`, `prototype` and `constructor`. An array declares its item type and
`maxItems` in 1–1,000, with editor default 1,000. Schema depth is at most 8, total
type descriptors at most 256, and properties per object at most 128. These are
proposed hard platform bounds, independent of existing node-value byte/depth/member
bounds. No unions, references, patterns, code, default insertion, coercion or
remote resolution. The existing SDK projection renders the corresponding
browser-safe JSON schema; the workflow-model callable contract owns bounded
runtime validation, not an arbitrary JSON-schema evaluator. Existing restricted
value-source policies own result mapping; no new expression evaluator.

Call node config pins workspace-local workflow ID, exact version ID, checksum and
callable-contract identity. Publication verifies that they agree, the child is
callable and executable, and the current editor may use it. Changing any pin,
callable schema or selector changes executable identity. An Upgrade action edits
the draft explicitly; republishing a child never changes a parent's retained pin.
Version rows hold the graph once. Dependency relations are verified derived
indexes of immutable pins, never competing graph or callable-contract truth.

Recommend initial hard platform bounds of four child edges deep, 64 child runs
per root execution, and 1,000 expanded node invocations across the complete pinned
family. These are accepted F08 bounds, not current implemented quotas. Count repeated
call sites and For Each products, not only distinct child versions. Reject any
ancestor workflow identity repeated on a call path, even at another version;
shared sibling dependencies remain legal. Validate the complete immutable closure
before publication, with bounded work and safe over-limit rejection. Runtime
records enforce the accepted worst-case budget monotonically; duplicate spawn
never consumes it twice. Do not truncate, refund/recalculate from Redis, or
silently increase existing loop/attempt limits.

New graph/executable/checkpoint formats are required where existing strict
contracts cannot express the declaration and call wait. Retain every current
graph/checksum and checkpoint parser; choose exact new format/policy versions in
the accepted ADR/catalog inventory, not by mutating V1/V2 semantics in place.

## Existing interfaces and the small extension

Keep `CoordinatorRunStore.loadAdvanceState` and `commitAdvancePlan` as the worker's
durable seam. Extend their bounded facts and the pure engine transition plan;
do not add a generic family scheduler, separate history store or public child
acceptance endpoint. The normal Call Workflow declaration attempt validates input
without provider I/O; the coordinator consumes that bounded declaration and
enters a dedicated call-control wait, analogous to the existing For Each control.
It never holds a worker while waiting for a child.

Proposed private plan/fact vocabulary (not code or an approved wire schema):

```ts
type ChildAdmissionIntent = {
  invocationKey: string;
  childWorkflowVersionId: string;
  inputReference: BoundedOutputReference;
  inheritedDeadlineAt: string;
};
type ChildAdmissionFact =
  | { kind: 'admitted'; invocationKey: string; childRunId: string }
  | { kind: 'refused'; invocationKey: string; reason: SafeCallRefusal };
type ChildTerminalFact = {
  invocationKey: string;
  childRunId: string;
  status: TerminalRunStatus;
  resultReference?: BoundedOutputReference;
};
```

All identity, byte, length and cardinality bounds come from accepted shared
contracts. Input/result references are scoped, checksum-bound and owned by
existing output/artifact persistence. New lineage is scoped by workspace, parent
run and the existing full branch/iteration invocation key. One durable call
record contains immutable request identity and either one child ID or one
definite refusal. Its unique key is not a 24-hour request receipt. Resolve a
recorded result before current capacity checks; mismatch is corruption/conflict,
not permission to allocate another child. Ordinary request/inbox receipts remain
with their existing owners and cannot replace call identity after expiry.

### Native byte owner and accepted inline byte preservation

Primary selected the existing persisted execution-value encoder for NEW native
input/result bytes/checksums on 2026-10-02. Reuse that implementation with an
explicit 1 MiB value bound; retain 256 KiB inline eligibility and all legacy,
graph/catalog and artifact quota identities. In particular, numeric-looking keys
are sorted lexicographically like the persisted encoder, not enumerated by the
model/graph JSON serializer. Prepare, record, read and hydrate must agree for
nested numeric keys, Unicode/escapes, finite numeric edges and negative zero.
NEW native artifact production uses that same encoder without reinterpreting
retained artifact bytes. SDK-valid NUL strings remain artifact-eligible only.

**Accepted by primary and independent review on 2026-10-02:** add an immutable exact
UTF8 serialized-value field to the existing protected inline provenance row,
retaining its normalized inline reference. SQL hashes/counts those exact bytes,
validates original JSON with unique keys before conversion, bounds depth/members/
bytes and finite numeric values, and binds value/reference plus live authority in
the same transaction. Read/reclaim verifies original bytes before bounded parsing
and semantic reference comparison; never infer historical byte identity from
JSONB. Canonical application producers remain unchanged. Raw SQL ingress
accepts unique-key alternate whitespace/order as distinct, recoverable immutable
byte identity; rejects duplicate keys, invalid/bounds/numeric/identity mismatch.
This accepted disposition changes earlier negative vectors that expected
whitespace/order rejection. No generic SQL JavaScript encoder, new
payload store/quota/history owner, artifact relaxation or legacy reinterpretation
is proposed. Exact byte replay preserves original identity; even semantically
equal rewritten bytes cannot replace a committed snapshot. See the accepted
amendment in ADR065. Primary and independent review narrowly closed original
inline-input poisoning and rounded-reference replay findings for candidate SHA256
`50897f0343e2f6b8dc87b7989a578ad1984217a89a67e8fd26cb3dec9fbdcb5b` after actual
worker-login record/read/replay evidence. The 108 scalar eligibility comparisons
are sampled platform proof; bootstrap publication/root/lease transitions do not
qualify actual publication, claim/process/crash, completion or the full feature.
SQL numeric/reference admission and recovery must agree under actual JavaScript
bounded parsing; PostgreSQL arbitrary-precision JSONB equality or finite casts
alone are insufficient. Compare numeric leaves with equivalent binary64 semantics:
raw `9007199254740993` may normalize to `9007199254740992` only when the reference
agrees with that same JavaScript value. Underflow and negative zero follow the
same normalization; overflow/nonfinite/unsupported ranges fail operationally.
Prove SQL/JavaScript differential numeric disposition, never rewrite original
bytes, and carry them through reclaim/completion without recanonicalization.
Exact bytes stay within existing inline 256 KiB eligibility and
wrapper/backstop policies, with existing provenance retention/hold/purge and no
duplicate reservation or hidden unbounded payload.

## Native artifact owner contract delta — accepted, 2026-10-03

**Accepted by primary after independent Spec/Standards closure.**
This is design acceptance, not executable qualification. It extends
[ADR065](../adr/065-durable-parent-child-workflow-calls.md#native-artifact-ownership-amendment--accepted-2026-10-03).
It does not supersede accepted inline bytes, native semantic verification or
screened security gates. The quarantined historical SQL remains untouched,
unregistered and unexecuted; future native migration work is separate from the
registered ordinary draft-storage migration0136.

### Relation and value identity

Add `workflow_execution_value_artifacts` under the existing artifact owner.
Before acceptance it records a **non-authoritative candidate**; after atomic
acceptance its nullable provenance association makes it a child of the existing
accepted value fact. No parent provenance is created by reserve or finalize.
It is not a new blob/quota/history owner:

| Field | Type and invariant |
| --- | --- |
| `workspace_id` | UUID, part of every key and foreign key |
| `candidate_id` | UUID from the existing persisted ID owner, stable across exact retries |
| `value_slot` | Exactly `call_input`, `physical_output` or `run_result` |
| `run_id`, `workflow_version_id` | Immutable UUID producer run/version identities |
| `attempt_id` | Nullable UUID; required for both attempt slots, absent for `run_result` |
| `creator_worker_id`, `creator_fence_token` | Attempt slots only: bounded existing worker identity and positive safe-integer creation fence; historical, not current authorization |
| `producer_outbox_event_id`, `producer_payload_checksum` | Exact canonical attempt/coordinator delivery identity; UUID and lowercase SHA256 hex `char(64)` |
| `provenance_id` | Nullable UUID, associated once only after the accepted parent exists in the actual acceptance transaction |
| `artifact_id` | UUID, exact existing artifact reserved for this candidate |
| `coordinator_expected_revision` | Nullable nonnegative integer; required only for `run_result`, pre-CAS revision |
| `coordinator_result_revision` | Nullable integer; required only for `run_result`, exactly pre-CAS revision plus one |
| `coordinator_result_identity` | Nullable lowercase SHA256 hex `char(64)`; required only for `run_result`, immutable result-bearing transition binding |
| `abandoned_at` | Nullable PostgreSQL timestamp, stamped once only for a definitively unaccepted candidate; mutually exclusive with non-null `provenance_id` |
| `created_at` | Immutable PostgreSQL timestamp |

Primary key is `(workspace_id, candidate_id)`. Unique
`(workspace_id, attempt_id, value_slot)` for attempt slots, and unique
`(workspace_id, run_id, coordinator_result_revision)` for `run_result`, enforce
one candidate per producer slot, **not** a new candidate per different checksum.
Unique `(workspace_id, artifact_id)` gives one owning candidate per artifact;
unique `(workspace_id, provenance_id)` where non-null gives one artifact
association per accepted value. Exact retries compare the same slot/run/version,
delivery and byte identity (checksum/length/media type from immutable artifact
metadata); mismatch is conflict, never another insert or quota charge.

Restrictive composite foreign keys bind candidate run, version and nullable
attempt to their existing same-workspace rows, and `(workspace_id, artifact_id)`
to existing artifacts from first reservation. Add a parent unique key
`(workspace_id, id, artifact_id)` for the restrictive, nullable `MATCH SIMPLE`
foreign key `(workspace_id, provenance_id, artifact_id)`: null provenance permits
only candidate storage; once non-null it must name the exact accepted parent and
artifact. Acceptance independently checks matching run/version/value-kind and
producer slot, then inserts the accepted parent and associates the candidate in
one transaction. No placeholder parent, altered seal or cascade is allowed.
Delivery columns retain historical identities without adding a new outbox-retention
pin; current command authority is independently resolved through existing owners.
Preview constraints remain untouched. Artifact metadata remains byte/storage/media/
lifecycle/finite-expiry authority; candidate rows contain no payload, expiry or
quota counters. Many accepted consumers may reference one original accepted value;
consumption does not create another owning candidate or provenance.

The existing provenance identity remains `(workspace_id, attempt_id, value_kind)`
for `attempt_input`/`attempt_output` and `(workspace_id, run_id,
coordinator_revision)` for `run_result`, with the latter revision the target
post-CAS revision. Require explicit command slots: `call_input` maps only to
`attempt_input` at an actual pinned Call declaration; `physical_output` maps only
to `attempt_output` at an ordinary physical node; `run_result` is coordinator-only.
Never infer a slot from bytes or a generic `attempt` owner. Call physical success
continues to alias its committed input, without a `physical_output` reservation.
The current codec's generic attempt owner must gain this explicit slot before
native persistent callbacks are wired; retained runtime interfaces are unchanged.

An unaccepted candidate is not input recording, physical completion or terminal
result. Reserve/finalize never inserts accepted provenance, so existing deferred
physical completion and terminal-result/receipt invariants retain their meaning.
Existing seals/readers must gain artifact-aware comparison/projection of the
exact accepted parent and associated candidate while preserving accepted-fact,
receipt, completion and current-authority checks and existing inline checks.
No provisional-parent exception, candidate-state filter or weakened seal. Only
the actual slot-specific record/completion/post-CAS receipt
transaction may insert that accepted fact and associate the candidate atomically.
Inline producers create accepted inline provenance through their unchanged owner,
without candidate rows. Artifact availability or a candidate alone cannot establish
accepted input/result or authorize source consumption. Existing semantic verification
requirements remain required and unqualified by this design.

### Commands, transactions and replay

Extend the existing execution-value owner behind the codec's `reserve`,
`assertReserved`, `finalize` and `authorize` seams; these are not public commands
and do not grant serving table writes. A reservation request names explicit slot,
actual attempt lease/delivery or coordinator delivery/revisions, admitted bounded
byte length/checksum/media type and (for result) its immutable result identity.
It returns the same artifact metadata plus availability. It never trusts metadata
or an artifact ID as execution authority.

The native producer owner is a closed union: `{ kind: 'attempt', slot:
'call_input' | 'physical_output', lease }` or `{ kind: 'run_result', workspaceId,
runId, workflowVersionId, delivery, expectedRevision, resultRevision,
resultIdentity }`. Every command revalidates that actual slot/owner; passing a
coordinator owner to an attempt slot is invalid. The result identity V1 hashes the
existing persisted native encoding of the bounded record containing workspace,
run/version, literal slot `run_result`, pre/post revisions, exact delivery
outbox/checksum, immutable declared result selector, existing ordered selected
source descriptors, and value checksum/byte length/media type. No payload copy,
trace context, retry clock or full plan is stored in this binding. Source descriptors
retain their existing scoped physical/logical reference grammar and are limited
to 1,000; the whole identity record must fit the existing 1 MiB encoder bound.
The checksum is only an identity comparison: SQL must establish the actual owner,
revisions, declaration and source facts independently, not authenticate a supplied
label or implement another JavaScript canonical encoder.

- Attempt reservation/recheck uses the actual current lease, worker, fence,
  canonical delivery, run/version/node/invocation and allowed slot, following the
  established Call/physical owner proof. One exact owner/slot/byte identity reuses
  its existing reservation; disagreement is operational conflict, not a new value.
  Reclaim proves the new current lease independently and retains historical
  candidate creation proof and, only where already accepted, original provenance.
  A committed input is read/hydrated, never mapped, prepared or charged
  again; physical completion still requires its current completion authority.
- Coordinator reservation binds actual advance delivery, `plan.expectedRevision`
  and target `plan.checkpoint.revision`, plus the result selector's exact immutable
  source identities and byte identity. `coordinator_result_identity` is a content
  binding derived by the existing transition owner, not an authentication label:
  same delivery/revisions/sources/bytes produce the same binding despite a later
  preparation clock. It must not replace the existing full transition fingerprint
  or independent source/selector verification at final commit. Store the actual
  full plan fingerprint only with its existing checkpoint/receipt owner.
- First reservation creates existing pending artifact metadata and its
  non-authoritative candidate atomically on one owner client, **no parent provenance**.
  Reuse performs
  no insert/charge. `workspaceTransactionFromClient` adapts that already scoped
  client only after tenant/native proof; no nested transaction or grant shortcut.
  The existing artifact insert trigger remains the sole capacity charge owner.
- Complete the short preparation transaction before spool/upload network I/O.
  Use the existing reserved writer/storage key, byte policy and dual-region store;
  no held execution/workspace row locks across upload. Recheck the same live proof,
  metadata and finite expiry in a new short finalization transaction, delegating
  `finalizeArtifactUpload` on that client without creating another reservation.
- Acceptance uses the existing input record or physical completion transaction;
  coordinator acceptance uses the existing authenticated transition, actual CAS,
  terminal result record and receipt transaction. Insert accepted parent provenance
  only there, atomically setting candidate `provenance_id` to that exact fact.
  Both must roll back if the existing deferred seal/receipt or any acceptance
  obligation fails. Extend existing owners with artifact-aware exact comparison,
  not seal deferral, bypass or provisional accepted-parent reinterpretation.
  Coordinator **pre-CAS** revision never becomes the recorded **post-CAS** result
  revision, and a prepared reference does not authorize a stale transition.
- Upload failure/cancellation leaves the exact pending candidate for existing
  retention. Upload succeeded but finalization/commit response is lost: inspect
  existing owner truth before retry; available reservation reuse does not upload
  or recharge. A committed value/result wins even if its creation lease is old.
  Stale/failed CAS never stamps a result or forces an obsolete plan. A changed
  result identity cannot overwrite/reuse the candidate; retire an uncommitted
  candidate only after the existing owner definitively resolves that its value
  was not accepted and its old transition can no longer commit. That owner may
  stamp `abandoned_at` only while `provenance_id` is null and shorten the existing artifact expiry, never extend it,
  so the existing bounded retention runner can remove its bytes and candidate
  metadata before another candidate for that still-uncommitted slot is admitted.
  Definitive abandonment removes producer, nonterminal-family and replay protection
  for this unaccepted candidate. Only actual independently accepted consumers or
  legal hold can still protect its bytes; do not manufacture a consumer/parent fact
  to keep it alive. While physical cleanup/metadata removal is outstanding, a
  changed candidate request returns explicit retryable `preparation_unavailable`
  (deferred), using existing delivery retry/backoff and immutable execution deadline.
  No busy loop, new candidate/result or extra charge. Legal hold may prevent
  replacement until that deadline: existing timeout/unknown-effect precedence and
  truthful reconciliation determine settlement, rather than silently hanging or
  bypassing the hold. Do not treat uncertain commit, transport loss or merely an old creator lease as
  abandonment. Non-result/cancellation transitions need not wait for physical
  cleanup; they cannot accept the abandoned value. Never delete a committed
  identity to make a different plan succeed.

For each short native command, lock the existing workspace lifecycle/admission
row SHARE first, then the established ordered ancestor/run prerequisites and
current attempt or coordinator checkpoint proof, then its candidate and, only
when actually accepting or reading accepted truth, provenance row,
artifact row and existing capacity row when a lifecycle mutation requires it.
Do not upgrade an ancestor lock, prelock capacity in the reverse order, or acquire
workspace behind artifact/provenance. Insert uses the existing artifact capacity
trigger, not a second counter reservation. Retention holds ADR013's destructive
advisory gate and workspace UPDATE before locking eligible candidate/provenance rows,
then artifacts; its extension must not acquire provenance behind an artifact it
already locked. Discovery reads are bounded and non-locking. Reuse already-held
locks and existing parent/child coordinator ordering; no ancestor acquisition
while holding a descendant terminal lock. The eventual exact statements remain
subject to implementation review, not a waiver of this order. No helper grant,
signature, attestation implementation or blocked verification bypass is supplied.

### Explicit native source projection

#### Borrowed child run-input binding clarification — accepted, 2026-10-04

Primary selected an explicit accepted child `run_input` binding borrowing exactly
one immutable owned Call `attempt_input` producer. The binding stores no original
reference/bytes, independent artifact association or quota charge; protected
resolution returns the existing `StoredExecutionValueV1` snapshot grammar, with
no new borrowed reference kind. A same-workspace composite foreign key and
complete owned/borrowed shape checks must require an owned `attempt_input`
producer, so alias chains and cycles are impossible. Any derived integrity
metadata is checked against that producer, not new authority.

The actual acceptance transaction and every authorized resolution independently
prove the immutable declaration/journal and exact parent/child/version/invocation,
current consuming authority, source availability and eligibility. UUID possession
is insufficient. Producer retention accounts for still-eligible borrowed consumers,
legal hold and bounded family/replay dependencies. Expired child input loses
eligibility and cannot retain original bytes indefinitely. This clarification is
implementation guidance for the fresh unregistered candidate, not installed
schema, writer/readiness or persistent/security qualification.

Only exact Graph2/executable3/Checkpoint3 selection may emit a typed native source
projection alongside ordinary inputs. Each record has a fixed target slot
(`run_input`, scoped `upstream_output`, or `wait_resume_output`), exact
`StoredExecutionValueV1` reference, byte length/checksum and original inline
serialized bytes where applicable. Run input binds its accepted run/value
provenance; physical output binds run/version/node/invocation/attempt; logical
Call result binds parent invocation and the one accepted child result provenance.
Use protected existing snapshot/result projections, not scanning nested JSON.
No duplicate slots, synthesized physical-attempt identity for a logical result,
or artifact reference supplied merely by possession.

Native `hydrate` supplies the explicit source descriptor separately from its
consuming authority (actual attempt lease or actual coordinator delivery/revision).
Its authorize adapter must resolve that exact accepted source/provenance ID and
reference through the existing loader/read owner and prove it is eligible for
this consumer's scoped slot. It cannot reinterpret producer creation authority
as current consumption authority or authorize an arbitrary same-workspace artifact.

The worker hydrates under the actual consuming lease after control checks, using
heartbeat cancellation and bounded source work, preserves invocation order and
scope, and never rewrites structured collections/coordinator inputs by guessing
references. Each value retains 1 MiB/depth64/member10000 limits and retained inline
256 KiB eligibility; do not aggregate source buffers with unbounded `Promise.all`.
Retained `NodeAttemptInputs` remains decoded JSON, including JSON resembling a
reference wrapper. Coordinator callable materials need corresponding explicit
source descriptors, but final commit must still independently establish the
selector and source truth through its existing owner. Worker hydration or a content
hash cannot supply that missing authority. Recovery retains original byte identity.

### Expiry, abandonment, retention and rollout

SQL owns finite `artifacts.expires_at` under existing run-artifact policy (ADR013
default 30 days), not the writer's `retentionMillis` or preview deadline. Native
references may delay deletion while genuinely needed, not create permanent pins.
Extend existing0080 discovery and preparation to expired pending
`purpose='execution-value'`, accounting for a still-live producer and accepted
dependencies; current code only discovers pending `user-upload`. Extend available
reference checks for original provenance and nonterminal root/parent/child,
replay-eligible history and legal hold. An uncommitted candidate alone must not
self-pin indefinitely; after its finite expiry and producer abandonment it is
eligible for the same existing retention owner. For a definitively abandoned
candidate with null provenance, ignore its producer's active/nonterminal family
and replay state; those are not accepted consumers. Legal hold and real accepted
consumer references still prevent destructive cleanup. Remove candidate metadata
in controlled order with existing artifact deletion only after confirmed physical
removal; there is no unaccepted parent provenance to delete or seal to relax.
Cleanup delay returns explicit preparation-unavailable/deferred on replacement,
not successful preparation. Cancellation and timeout transitions without a result
do not wait for candidate cleanup. Once associated, the accepted provenance and
its actual parent/child/replay consumers retain their existing protection.

Extend existing0055 detail-page eligibility before removing child attempts/nodes/
events/checkpoints, source provenance or summary projections required by a
nonterminal parent, replay window or hold. Once dependencies end, delete links and
provenance in bounded resumable dependency order before restricted referenced
rows; preserve normal expiry/redaction. Extend existing compatibility inventory
and workspace purge so no residual relation blocks a tombstone or releases needed
facts early. No new family reaper, alternate object store or retention policy owner.

Preserve legal-hold/control-ledger high-water checks and ADR013's short prepare /
external delete+head / short completion protocol with workspace destructive
serialization. Capacity stays charged through pending/available/deleting, released
once only after physical deletion confirmation through the existing artifact owner.
Unavailable or uncertain deletion defers; it does not free quota or claim success.

Required ordinary tests at existing seams: explicit slot routing; exact reservation
reuse with one capacity charge; above-inline/NUL preparation and hydration using
existing bytes; upload failure/cancellation and lost finalization response recovery;
preparation-versus-post-CAS revision identity; no parent provenance before actual
acceptance, association rollback with a failed existing seal/receipt; abandoned
candidate cleanup despite an active producer family, legal-hold deferral and
bounded replacement-unavailable/deadline settlement; retained JSON
wrapper non-hydration; scoped physical versus logical source selection; bounded
pending expiry, parent/replay dependency retention and resumed cleanup after holds.
These normal tests do not retry screened adversarial/security probes or substitute
for their still-required qualification.

Native writers/catalog/execution stay OFF until reviewed migration/readiness,
source-bound mixed-writer compatibility/cutover, actual provenance/retention,
recovery and full F08 gates pass. Existing compatible accepted continuations remain
truthful when OFF; old writers must fail closed on unsupported native formats.
No down migration, destructive data rewrite, historical draft installation or
production enablement is authorized by this accepted design alone.

## Atomic spawn, FIFO and lock contract

Extend the canonical coordinator transaction and existing `acceptWorkflowRun`
implementation, including ordinary queued-run insertion, pinned entitlement,
initial checkpoint/event/outbox, current compatibility and failure-notification
policy. Expose no general worker bypass of the dispatcher reservation helper.
Today acceptance takes `WorkspaceTransaction` and the coordinator takes the
already checked-out `PoolClient`. The proposed concrete internal adapter is
`workspaceTransactionFromClient(client: PoolClient, workspaceId: WorkspaceId):
WorkspaceTransaction` in `tenant-access/workspace.ts`: construct
`drizzle(client, { schema: databaseSchema })` and freeze `{ db, workspaceId }`,
exactly as `withWorkspaceTransaction` already does. Both callers reuse this
factory. It does not acquire/release a client, begin/commit/rollback, change scope,
or outlive the owning `withTenantScopedClient` callback. Coordinator transaction
hygiene, cancellation, protocol and workspace-first lock remain the outer owner.
Call existing `acceptWorkflowRun` on that adapter, extending its strict internal
input for a `workflow_call` trigger and immutable lineage; do not duplicate SQL
or introduce another admission protocol. Manual is the child's graph entry node,
**not** its persisted trigger type: do not impersonate an API manual start or
bypass the existing checked-manual-start fence.

Propose worker-only, tenant-bound
`app.lock_workflow_call_admission(parent_run_id uuid, expected_revision integer,
invocation_key text, candidate_run_id uuid)`. Canonical acceptance allocates the
candidate ID with its existing ID owner and passes it with the strict internal
child context (parent ID/revision/invocation), never caller-supplied actor or
arbitrary root identity. The coordinator prelocks the ordered prerequisites below;
the helper verifies/reuses them and refuses any unbound insertion. It resolves the retained call site/root authority and
immutable bounded lineage from durable pins, validates them, and binds only that
candidate child insertion/reservation. Add no general reservation-helper grant
to worker. Any security-definer helper has fixed search path, tenant/identity
checks, owner-defined SQL, PUBLIC/other-role revocation and only worker EXECUTE;
no arbitrary identity-table SELECT/UPDATE grant. SQL writer/commit fences must
reject a `workflow_call` child without its exact parent CAS/call record and
ordinary reservation, including a direct worker insert or an old writer. The
canonical acceptance module remains the row/event/checkpoint/outbox owner; the
proof helper is narrow enforcement, not a second acceptance implementation.
After canonical acceptance has created its outbox, the equally narrow worker-only
`app.reserve_workflow_call_active_admission(parent_run_id uuid,
expected_revision integer, invocation_key text, candidate_run_id uuid,
outbox_event_id uuid)` revalidates that exact durable call proof, pin/input and
new child/outbox identity and delegates to the existing
`reserve_workflow_run_active_admission` implementation. It creates no alternative
capacity/FIFO calculation. It may operate only on the new candidate bound to the
still-held parent CAS; identity/protocol mismatch throws, a definite canonical
capacity/FIFO refusal returns false. Its tenant/role/definer restrictions match
the proof helper; worker cannot call the unrestricted dispatcher helper directly.
The exact-call fast path loads and verifies the already recorded identity/fact
first and performs only the existing parent CAS/receipt continuation; it does not
invoke fresh-admission authority/active-policy checks. A record appearing during
fresh admission is rechecked under the immediate-parent CAS and converges on that
same record. Reading an inactive actor row for lock ordering is not reauthorizing
or rejecting an already accepted/refused call.
A narrowly scoped internal child path must bind its parent CAS, exact published
call site/input and root admission authority before requesting the same canonical
reservation checks. Persist the call record, parent call-control checkpoint CAS,
child acceptance/reservation and events/outboxes in one outer transaction.

Primary clarified declaration recovery on 2026-10-02: the input snapshot belongs
to the immutable logical Call and its exact physical declaration attempt; its
creation lease/fence is historical provenance, not current execution authority.
If an undispatched attempt is reclaimed after input persistence, authenticate the
new current lease/fence/delivery independently and reuse the protected committed
snapshot for that same attempt/run/version/invocation/reference/checksum. Never
rerun its mappings, rewrite or re-reserve the snapshot, or create another logical
Call/child. A historical fence less than or equal to the current fence is only a
consistency condition, not authentication: the provenance must originate from
the protected writer, retain its valid creation fence, and reject stale leases,
changed identities, references or checksums. Completion still requires current
lease/fence/delivery authority. Crash-after-input-before-dispatch recovery and
exactly-one-child proof remain required implementation evidence, not established
by this clarification. This routine recovery clarification requires no new ADR.

Every candidate acceptance operation runs within the savepoint, not just reserve.
If the speculative child is authoritatively refused, a savepoint rolls back **all** candidate
child acceptance rows, claim, initial event/checkpoint/outbox and reservation;
ticket sequence gaps are allowed. The outer parent CAS commits only the one
refusal fact and parent continuation. The pure engine consumes that fact and
derives node/run failure on the next advance; SQL does not independently derive
aggregate run status. A crash between refusal and consumption recovers the same
fact, never attempts fresh admission. Losing parent CAS rolls back both admitted
and refused branches and reloads/recomputes.

Only definite, locked/authoritatively observed business-policy outcomes become
immutable refusal facts. Proposed safe classifications are:

| Observed outcome | Durable call outcome |
| --- | --- |
| Workspace/child workflow active slot unavailable or earlier eligible FIFO ticket | `workflow.child_capacity_unavailable` |
| Ordinary queued limit reached | `workflow.child_queue_unavailable` |
| Current entitlement absent, suspended, expired or not yet effective | `workflow.child_entitlement_unavailable` |
| Initiating actor/membership inactive, revision changed or `run:start` lost | `workflow.child_authority_unavailable` |
| Workspace inactive, child archived or current region admission denied | `workflow.child_admission_unavailable` |
| A supported compatible artifact authoritatively reports the pinned child no longer admissible | `workflow.child_compatibility_unavailable` |

All refusals converge on the same logical call record and ordinary required-node
failure, with zero child rows/reservations/outboxes after savepoint rollback.
Invalid typed input is rejected by the declaration's existing durable node-failure
fact before a child intent exists, with no automatic Call Workflow attempt retry.
Ancestor cancellation/deadline yields authoritative control observations and
normal cancellation/deadline precedence, **not** a misleading capacity refusal.
Exact recorded admitted/refused calls are resolved before current policy checks.

Connection loss, statement/lock timeout, deadlock, missing required counter/pin/
artifact, malformed facts, identity conflict, unsupported writer protocol or
compatibility artifact, and unexpected SQL/transport errors roll back the entire
outer transaction for existing recovery; they never become definite refusal.
A SQLSTATE alone is insufficient: for example `PTA01` covers both entitlement
denial and broken required admission state. Classify only an explicit typed
policy result proven under the relevant locks. After uncertain COMMIT, reconnect
and resolve the same durable call/CAS identity before doing anything new; do not
infer zero children from a socket failure. No new retry scheduler is introduced.

Proposed acquisition order for the new child-bearing coordinator path:

1. Shared workspace lifecycle/admission lock; current user/membership authority
   where applicable; current compatibility release.
2. Target workflow lifecycle/version, failure-notification policy/destination and
   notification connection locks, then current entitlement pointer/version,
   **before** run/checkpoint/counter locks. Multiple target workflows use stable
   workflow-ID order. Do not prelock concurrency-policy rows: their update owner
   acquires the counter first; eligibility reads those rows under the same counter.
3. Verify the immutable lineage (at most four edges), then lock ancestor run rows
   `FOR SHARE`, individually root-to-immediate-parent, excluding the immediate
   parent. Lock that parent run/checkpoint directly `NO KEY UPDATE`, never SHARE
   followed by a lock upgrade. For a root calling directly, there are no separate
   ancestor locks. Revalidate every lineage edge/root identity, expected revision,
   executable/invocation, all ancestor cancellation and PostgreSQL-clock deadlines;
   serialize the call record. A mismatched/missing lineage is corruption, not a
   caller-selected chain or a policy refusal.
4. Workspace admission counter; candidate **new** child rows and outbox; ordinary
   ticket/FIFO eligibility and reservation insertion. The child rows belong to
   this transaction, so their FK locks cannot wait on another child owner.
5. Parent checkpoint/events/facts/outboxes and receipt completion; commit.

Do not look up/lock an already accepted child's run behind the counter: exact
record replay does not reacquire its reservation. Dispatcher retains its current
workspace/run key-share-before-counter order. Existing reservation recovery does
not take the counter or lock a parent. Child terminalization writes its own
terminal truth and a parent identifier-only wakeup in the same transaction; it
**never** locks parent run/checkpoint while holding the child. The parent later
loads the immutable terminal fact through its existing advance seam. Cancellation
propagation similarly emits bounded control intents instead of locking a whole
family while holding one run.

Ancestor locks are the cancellation linearization fence, not a family scheduler.
Cancellation of any ancestor/subtree takes UPDATE on its selected run, so either
spawn commits first and that child is admitted work requiring cancellation, or
cancel commits first and the blocked spawn rereads it and accepts no child.
Hold the lineage locks through outer COMMIT. Never acquire an ancestor while
holding a descendant run/counter; one advance cannot both spawn and terminalize
the same immediate parent. Deadline timestamps are immutable; recheck the clock
just before insertion/reservation. Deadline-marking updates serialize on the same
ancestor locks; expiry does not depend on a delayed control message. An admission
whose final clock check precedes expiry can commit as accepted and is canceled/
timed out normally, never retroactively erased. Control outboxes still propagate
to already admitted children without multi-run update locks.

Opposing-path reconciliation against the current baseline:

| Existing owner | Current order / required preservation |
| --- | --- |
| API manual/root acceptance (`0131`, `execution-acceptance.ts`) | workspace → actor/membership → command identity → canonical admission; acceptance notification and entitlement locks precede insertion/counter. Child uses a distinct narrow proof, not manual-writer impersonation. |
| Membership commands (`identity-workspace-member-command.ts`) | workspace UPDATE → users in identifier order UPDATE → memberships → command receipt. Child workspace SHARE serializes ahead of those changes; do not acquire workspace after actor/membership. Invitation rejoin retains its workspace/user/membership order and increments the removed membership revision. |
| Compatibility selection/activation (`0019:179–217,400–424`) | serving selector locks current pointer/release SHARE before workflow/run; activation locks that pointer UPDATE and approval/release, not tenant run/counter locks. New retirement dependency inventory must remain read-only/bounded rather than acquiring run locks behind the pointer. |
| Publication (`workflow-publication.ts`) | workspace/actor/membership → compatibility → workflow/draft UPDATE; no existing-run lock. New dependency publication reads a bounded tentative pin set, locks all involved mutable workflow rows (own row included) in stable order before its draft, then rereads/verifies draft revision/pins; a change retries/conflicts instead of acquiring a new lower-order lock. It never locks runs/counter. Immutable closure pins are not copied or independently mutated. |
| Concurrency control (`0127:328–375`) | workspace/authority → workflow SHARE → receipt → entitlement SHARE → counter → concurrency-policy update. No concurrency-policy lock before counter in child path. |
| Notification/connection policy (`0088:415–440`, `0128:307–317`) | acceptance locks policy/destination then connection before run/counter; existing terminal notification intents use pinned references/FK key-share, not current policy locking. Preserve that separation. |
| Dispatcher/reservation (`0127:267–302`) | workspace/run KEY SHARE before counter; never ancestor SHARE or run UPDATE behind counter. Ancestor SHARE and parent NO KEY UPDATE are compatible with those FK locks. |
| Ordinary coordinator terminal/control (`coordinator-run-store-commit-state.ts`, run transition) | workspace → its own run/checkpoint NO KEY UPDATE → node/attempt facts → counter/FK writes. No ancestor/child UPDATE or current target-policy lock from a terminal producer; new child terminal wakeup uses parent identifier only. |
| API cancellation (`workflow-run-cancellation.ts`) | workspace → selected run UPDATE → cancel fact. It does not lock descendants; the new root-to-parent SHARE fence blocks only the selected ancestor. |
| Lifecycle/retention/purge (`workflow-authoring-lifecycle.ts`, `0080`, workspace control ledger) | workspace/control ledger before workflow/run/artifact deletion locks. Workspace exclusive destruction prevents overlap with the coordinator's workspace SHARE; ordinary workflow archive UPDATE serializes against target workflow SHARE without run/counter locks. Do not acquire workspace behind lineage/counter. |
| Reservation recovery (`0127`, current recovery helper) | reservation/outbox rebind only, no counter/parent/ancestor; exact existing child replay never re-reserves. |

This is a proposed lock contract, not executable proof. Independent reconciliation
and real blocker/race tests must close every path before SQL, including root and
intermediate-subtree cancellation winning/losing admission, lineage bounds,
multiple sibling declarations, policy changes and dispatcher/counter contention.
Deadlock retries are not its justification.

## Authority, lifecycle and preview

Publishing a call requires current workflow-publication authority and readable,
same-workspace executable child pins; pinning grants no later authority. Fresh
child acceptance checks active workspace and child lifecycle, current compatible
admission, regional admission, current entitlement, queue cap and workflow/FIFO
rules. An archived child denies new spawn; an already accepted child settles and
its exact admission result remains recoverable. Parent archive is not cancellation
of the accepted parent. Workspace deletion prevents new children and drains both
parent and children through existing lifecycle owners.

Recommend durable root initiation authority rather than inferring identity from
an idempotency scope or using the child's publisher. Human manual/API/replay
parents carry their actual initiating actor and membership role revision at root
acceptance. Fresh children require the same revision, active actor/membership and
`run:start`; any authority revision change (including promotion, removal/rejoin
or suspension/restoration) refuses a future child without retroactively canceling
an already accepted child. Original session expiry alone is not revocation of
durable work. Explicit root replay authorizes a new current context. Automated
schedule/webhook parents carry a workspace-owned admitted-trigger authority,
not a fabricated human actor or publisher session. Pausing the trigger does not
cancel its already accepted root; current child lifecycle/security gates remain.
The durable authority direction and bounded revocation behavior are accepted;
baseline workflow-run rows do not contain an initiating principal.
Revision pinning deliberately rejects even a promotion that still grants
`run:start`; primary selected this conservative product tradeoff separately from
capacity. Current role changes increment only when changed; removal/leave,
membership suspend/reactivate, ownership transfer and removed-member invitation
rejoin increment `role_revision` in their existing owners. This does not assert a
new user-global or workspace suspension generation: those current status checks
deny while inactive, and only implemented membership revisions remain pinned.

Connections remain the child's own pinned workflow references and existing
credential-resolution/revocation policy; no inherited parent credential map,
raw secret in input, or child publisher's credential authority. Lineage/history
reads use existing `run:read` and workflow-name disclosure rules; inaccessible
links reveal no workflow name or private execution input/result.

V1 node preview validates call config/input/pins only and explicitly reports
that durable child execution is unavailable in preview. It does not secretly
accept production children, consume another person's quota or emulate success.
Whole-family execution previews require their own approved isolation/accounting
design and are not delivered by F08.

## Deadline, cancellation and outcome precedence

Pin a one-hour effective default upper bound in the **new executable family
policy at publication and the root's accepted immutable policy**, reduced by
the caller's deadline or configured workflow duration; this introduces no default
change for retained non-call workflows or an ambient fallback on recovered runs.
Each child deadline is the minimum of the
parent's absolute deadline and its own configured duration at acceptance, so
queue/wait time consumes the budget and a child can never extend its parent.
Recheck the PostgreSQL clock inside admission, not a worker timer.

Parent cancellation prevents unaccepted calls and durably requests cancellation
of admitted children. Child cancellation is an ordinary cancelable run action;
it settles the parent's call as a non-success. Cancel/deadline controls work at
full capacity and recover after Redis/process loss. No fresh sibling/deeper call
is admitted once the root/parent cancellation or deadline is observed.

Preserve ADR007's truth: unresolved possibly completed child effects make the
call and parent `outcome_unknown`, ahead of cancellation, timeout and failure.
Otherwise parent cancellation wins, then parent deadline, then a required child
failure/non-success; success requires a validated child result. Do not mark a
parent finally canceled/timed-out before admitted child effects are terminal or
truthfully reconciled. A completed child remains immutable when cancellation
races it. A child timeout is a definite call failure unless the parent's own
deadline has expired; its detail stays visible without inventing another status.
An unknown child is never automatically spawned again, retried as a new run or
rewritten to canceled. User replay creates a new parent and new child identities.

## Retention, compatibility and delivery gates

Retain immutable transitive child-version pins while referenced by active
publications, admitted/nonterminal families, replay-eligible history or legal
hold. Existing compatibility retirement inventory/query must include those
dependencies. Child call/result/terminal facts and referenced artifacts cannot
be reaped while a nonterminal parent still needs them, even when ordinary child
detail expiry has elapsed. Charge artifacts once through their existing owner;
references extend retention, not free capacity. Normal expiry after dependencies
end is bounded and resumable; legal hold prevents destruction, never execution.

Child/run lineage follows existing summary/detail retention and workspace purge
owners. A held child or parent retains the evidence required to interpret the
link and pinned version. Do not use cascades that erase live/held evidence or an
indefinite retention cycle; document the dependency-aware purge order and indexed
bounded maintenance queries before schema. Historical links can later show
unavailable detail without fabricating a result or starting another child.

Keep new placement/publication and root-family admission off until schema,
compatible readers/executors, reservation enforcement and live gates pass. OFF
blocks new F08 roots/publications but keeps compatible accepted-family execution
and accepted-child settlement; existing bounded continuations remain subject to
current lifecycle/authority/entitlement checks. Old serving artifacts must fail
closed on new call formats and SQL writes, not claim unsupported child work and
exhaust its transport retries. Prove preactivation and already-running old writer
barriers; a UI flag or startup check alone is insufficient. Rollback retains
the enforcing compatible artifacts until accepted families drain; no down
migration, old-format rewrite or subtractive executor rollout is implied.

Required evidence: model/schema/pin/cycle/bound tests; real PG duplicate spawn,
CAS rollback, queue/workflow/FIFO/cap-one/full-cap races, lifecycle/member/compat
revocation, cancellation/unknown precedence and held retention; actual worker
death before/after spawn and settlement, Redis loss, duplicate wakeup and one
parent resume; real ordinary UI/API/worker typed call, explicit pin upgrade,
links/result/failure/cancel and access loss; old-image/OFF/retained-version proof;
source-bound required owned CI, coverage and separate design/implementation review.

## Exact current-source anchors

- [ADR012](../adr/012-fair-admission-backpressure-entitlements.md):16–31,
  [ADR058](../adr/058-workflow-concurrency-queue-admission.md):24–57 and
  [ADR057](../adr/057-workspace-usage-capacity-and-retained-activity.md):15–29:
  waiting occupancy, independent capacity and reservation/FIFO semantics.
- [Concurrency SQL](../../packages/database/migrations/0127_workflow_concurrency.sql):67–103,
  211–302 and [lock contract](../operations/workflow-concurrency-enforcement.md):9–54:
  authoritative predicates, counter serialization and non-inverting FK locks.
- [Graph](../../packages/workflow-model/src/graph-contract.ts):45–71 and
  [limits](../../packages/workflow-model/src/graph/validation-contract.ts):15–22:
  only For Each structure today; expanded work is bounded to 1,000 per graph.
- [Executable](../../packages/workflow-engine/src/compilation/executable-foundation.ts):80–99,
  [ADR002](../adr/002-postgresql-jsonb-drafts-immutable-versions-checksum-identity.md):49–74 and
  [ADR010](../adr/010-node-executor-compatibility-retirement.md):55–108,213–253:
  immutable pinned execution and compatible retirement dependencies.
- [Coordinator](../../apps/worker/src/execution/coordinator-handler.ts):104–149,
  [commit](../../packages/database/src/execution/coordinator/coordinator-run-store-commit.ts):85–166 and
  [transactions](../../packages/database/src/execution/coordinator/coordinator-run-store-transactions.ts):34–44:
  pinned version, pure decision, existing CAS/outbox seam and workspace-first locks.
- [Checkpoint](../../packages/workflow-engine/src/checkpoint/checkpoint-v1.ts):257–267 and
  [persisted parser](../../packages/database/src/compatibility/persisted-workflow-checkpoint.ts):43–60:
  current waits have timed/loop semantics, not child identity.
- [Acceptance](../../packages/database/src/execution/runs/execution-acceptance.ts):27–44,277–430 and
  [run schema](../../packages/database/src/schema/execution.ts):18–79:
  existing acceptance owner, five trigger types and no durable initiating principal.
- [Transaction adapter](../../packages/database/src/tenant-access/workspace.ts),
  [member commands](../../packages/database/src/tenant-access/identity-workspace-member-command.ts),
  [membership lifecycle](../../packages/database/src/tenant-access/identity-workspace-membership-lifecycle.ts),
  [invitation rejoin](../../packages/database/src/tenant-access/identity-workspace-invitation-acceptance-store.ts):548–557:
  one checked-out client, workspace-first authority and actual revision transitions.
- [Cancellation](../../packages/database/src/execution/runs/workflow-run-cancellation.ts):41–44
  and [manual fence](../../packages/database/migrations/0131_checked_manual_start.sql):43–98:
  selected-run UPDATE and API-only manual trigger enforcement, not child admission.
- [Run contract](../../packages/contracts/src/http/workflow-runs.ts):39–45,114–154:
  strict existing trigger/summary wire; no child lineage yet.
- [ADR007](../adr/007-run-node-state-retry-idempotency.md):36–43,156–180,
  [ADR034](../adr/034-workflow-archive-restore-and-activation.md):46–55,
  [ADR042](../adr/042-workspace-member-removal.md):70–75 and
  [ADR013](../adr/013-retention-workspace-deletion-legal-hold.md):44–80:
  terminal truth, archived admission, removed-member continuation and held purge.

Release allocated additive migration0136 exclusively to F08 after globally
checking all refs/worktrees. Primary accepted the qualified immutable integration
base above and authorized implementation. No F08 schema/runtime behavior or
executable proof exists at this decision-recording checkpoint.
