# ADR065 — Durable same-workspace workflow calls

Status: **ACCEPTED — 2026-10-02.**
Primary accepted the complete decision at commit
`b6c2998d29408b086c289e87058f9c67d2008ff2`, tree
`777b902351dd2a0fee2b067993ede3bc4ab1364c`, after full source review and independent
Standards/Spec closure. Both reviews closed ancestor cancellation fencing;
Spec also closed definitive pre-reservation refusal classification. No actionable
delta findings remain. This is design acceptance, not executable proof.
Release owner globally reserved ADR065 exclusively for this F08 draft on
2026-10-02; allocation is not decision acceptance. Parent
[F08](../feature-plans/08-subworkflows.md); binding details and current-source
reconciliation in [the contract proposal](../feature-plans/08-subworkflow-contract-proposal.md).
Primary authorized implementation after accepting the release-qualified integrated
F07 base `0b4e0810d405ecb0b222a2e000d363ef4fbd2380`, tree
`27c2362ba58c9eb161335d89a6665200403d8052`, and exclusive migration0136 allocation.
Required real-service, compatibility and rollout evidence remains open.

## Native execution byte identity amendment

Primary selected the existing persisted execution-value encoder on 2026-10-02
for NEW native input/result bytes and checksums, with an explicit 1 MiB value
policy. Reuse its bounded normalization and encoding implementation: UTF16
lexicographic object keys (including integer-looking keys), existing JavaScript
scalar/string spelling and negative-zero normalization. Retained 256 KiB inline
eligibility, legacy values, graph/catalog checksums and their codecs do not change.
The model's graph canonical JSON is not the native execution byte owner.
NEW native artifact production also uses this selected encoder; retained artifact
bytes are not reinterpreted. The native byte policy keeps SDK-valid NUL strings
eligible for artifact encoding, without making them PostgreSQL-inline eligible.

The following protected byte-preservation amendment is **ACCEPTED — 2026-10-02**
after primary and independent full-delta review. This is decision acceptance, not
closure of the SQL poisoning finding or executable qualification. Store exact
immutable UTF8 serialized inline-value bytes alongside their normalized inline
reference in the existing execution-value provenance
owner. SQL derives/checks SHA256 and byte length from those same durable bytes,
not a re-encoding of JSONB or a caller label. The byte record is authoritative for
integrity/replay; the inline JSON reference is the value projection used by
existing consumers, not an alternative content identity or storage owner.

Normal producers emit the selected persisted encoding. Protected SQL
ingress intentionally tolerates alternate whitespace/key order for otherwise
valid, unique-key, bounded JSON: it seals their exact bytes, never calls them
canonical or rewrites them, and recovery verifies those bytes before parsing the
semantic value. Duplicate keys at any nesting, malformed JSON, non-finite/out-of-
range numeric input and bounds/identity mismatches fail operationally before
commit. SQL validates the original text with PostgreSQL18's unique-key JSON
predicate before JSONB conversion, and enforces the existing depth64/member10000
and inline/value byte policies, rather than implementing a JavaScript serializer.
Original bytes and normalized reference must denote the same input. Recovery
and SQL admission must agree under actual JavaScript bounded parsing, not merely
PostgreSQL arbitrary-precision JSONB equality. Numeric leaves use equivalent
binary64 semantics: raw `9007199254740993` may normalize to `9007199254740992`
only when the reference agrees with that same JavaScript value. Underflow and
negative zero likewise follow bounded JavaScript normalization; overflow,
nonfinite or unsupported range cases fail operationally. Raw byte identity is
never replaced by normalized numeric spelling. Differential SQL/JavaScript
rounding, underflow, overflow, negative-zero and producer edge vectors are required.
Recovery checks stored byte/hash/length and bounded semantic value/reference agreement;
it must not recompute historical byte identity from JSONB. A later attempt to
change whitespace/order is a different immutable byte identity and is rejected.

This amendment changes treatment of hostile whitespace/key-order calls from
rejection to recoverable byte-preserving admission; duplicate-key calls remain
negative. It avoids an improvised generic SQL canonical encoder. Existing
canonical artifact preparation/hydration stays with its current artifact owner
and selected NEW native encoder; this amendment is not permission to accept
arbitrary artifact bytes or add a JSON store, quota/history owner or reaper.
Primary and independent review narrowly closed the original input-byte poisoning
and rounded-reference replay findings for candidate SHA256
`50897f0343e2f6b8dc87b7989a578ad1984217a89a67e8fd26cb3dec9fbdcb5b`.
Actual worker-login record/read/replay preserved immutable bytes, first projection
and current authority. The 108 scalar eligibility comparisons are sampled
PostgreSQL18 platform proof, not universal numeric equivalence. Publication/root
facts and lease transitions were bootstrap fixtures; actual publication, claim,
process/crash, completion, artifact and full-feature qualification remain open.
Exact inline bytes remain within the existing 256 KiB inline eligibility and
wrapper/backstop policies. They share the existing provenance retention, legal
hold and purge owner: no duplicate quota reservation or unbounded hidden payload.

## Native artifact ownership amendment — accepted, 2026-10-03

Primary selected additive artifact candidate storage with atomic association to
accepted execution provenance and explicit value slots on 2026-10-03. **This amendment's concrete contract is
ACCEPTED by primary after independent Spec/Standards closure.**
The previously accepted decision and byte-preservation amendment remain accepted;
this section neither accepts a migration nor closes any F08 qualification gate.

Keep `artifact_links` exclusively preview-owned, including its preview foreign
key, owner-kind constraint and retention trigger. A narrow relation under the
existing artifact owner records non-authoritative candidates with stable producer,
slot and byte identity. Reservation/finalization creates no parent
`workflow_execution_value_provenance` row. Only the existing actual input record,
physical completion or coordinator acceptance transaction inserts that accepted
fact and atomically associates the candidate with its exact parent/artifact.
Existing accepted-fact, receipt, completion and current-authority invariants remain
unchanged. Their existing owners must gain artifact-aware comparison/projection
of the exact accepted parent and associated candidate while retaining inline
checks; no provisional-parent exception, candidate-state filter or weakened seal.
The association becomes a child relation only after acceptance. It stores no
payload, charges no quota and grants neither possession authority nor a new
history/retention owner. Retained and native inline acceptance remain unchanged.
Distinguish Call declaration `attempt_input`, ordinary physical `attempt_output`
and coordinator `run_result`. Call completion aliases its committed input and
never prepares an output reservation. Creation authority remains historical;
recovery authenticates the actual consuming lease or coordinator delivery afresh.

Reservation, existing artifact insertion/finalization and provenance acceptance
reuse the established tenant/native owner transactions. Adapt an already scoped
client with `workspaceTransactionFromClient` only after proof is established;
never open a nested transaction or treat that adapter as authority. Coordinator
preparation binds actual delivery, **pre-CAS** expected revision and immutable
result-bearing transition identity; accepted result provenance records the
**post-CAS** checkpoint revision. Upload occurs outside execution locks and SQL
transactions. Failure or stale CAS cannot fabricate completion, change reserved
bytes or charge a second time; existing bounded retention owns abandoned bytes.
Definitive abandonment removes producer/nonterminal-family/replay protection for
an unaccepted candidate: only actual accepted consumers or legal hold may retain
it. Replacement waiting for confirmed physical cleanup is explicitly retryable
preparation-unavailable under the existing delivery/deadline, never a busy loop.
Hold cannot be bypassed; cancellation/timeout settlement does not wait for cleanup.

Only the exact Graph2/executable3/Checkpoint3 loader emits explicit typed native
source references with immutable byte identity and physical/logical source
provenance. Retained inputs stay decoded JSON. Hydration consumes those records
under current authority, never guesses references inside arbitrary JSON or
prepares recovered values. Coordinator commit retains independent selector and
source verification; worker-hydrated values alone are not commit authority.

Extend existing pending/available artifact discovery and preparation, execution
detail retention, compatibility retirement and workspace purge for native
provenance and root/parent/child/replay dependencies. Keep finite expiry and
bounded resumable release once dependencies end; no permanent family pin. Preserve
ADR013's legal hold, control-ledger and workspace destructive serialization,
single artifact capacity charge and confirmed physical deletion before release.
The [accepted contract delta](../feature-plans/08-subworkflow-contract-proposal.md#native-artifact-owner-contract-delta--accepted-2026-10-03)
defines the fields, slots, commands, recovery and ordinary qualification slices.
Native execution remains OFF. Platform-screened security qualification remains
PAUSED; this amendment authorizes no retry, attestation implementation or SQL install.

## Coordinator native value demand amendment — ACCEPTED, 2026-10-03

This amendment is **ACCEPTED by primary after independent Spec/Standards closure,
including the literal-preparation lifetime clarification, 2026-10-03**. The accepted
decision and amendments above remain authoritative. Concrete accepted interface
types, policy and required tests are in the
[coordinator demand proposal](../feature-plans/08-coordinator-native-value-demand-proposal.md).

The existing engine determines a pure transition before callable completion,
but currently receives eagerly decoded material. The commit owner independently
recomputes result selection while its workspace transaction is open. Extending
either loader with artifact reads would hold SQL transactions across object I/O;
replacing independent recomputation with worker values or a content hash would
weaken accepted source authority. We propose demand-only material after a pure
`run.succeeded` transition and valid unique root selection, plus commit-owned
independent accepted-source hydration, semantic recomputation and result candidate
preparation entirely outside SQL. The final short write transaction independently
rechecks actual current delivery/revision/controls, the whole immutable callable
declaration and exact accepted source inventory before existing CAS/result/receipt
acceptance. It binds previously verified object bytes to unchanged authoritative
facts; it does not pretend SQL can compute an expression from an artifact hash.

Only a typed ready material or existing typed invalid-context result may continue
completion. Typed canceled, timed-out, stale, context-aborted and retryable
unavailable work stops propagate through the engine wrapper, handler and commit
without a success plan or `child_result_invalid`. Retryable stops must not be
silently acknowledged as completed queue work. A later existing authorized advance
observes actual controls; no new cancellation fact, child failure or second CAS
is fabricated. Malformed state/byte/authority errors retain their own errors.
Reject simultaneous eager/demand configuration before completion or provider work.
Retained inline/eager parsing, byte identity and commit behavior remain unchanged.

One framework value-lifetime module owns two sequential resource scopes: lazy
success-demand/evaluation, then independent precommit hydration/evaluation/
preparation/acceptance. Each has immediate actual-owner precheck on first value
work, a single non-overlapping control watcher, pre/post-work checks and final
transaction recheck; both use the same policy and actual coordinator read owner,
not a node-attempt lease. A literal selector skips provider/control-watcher work
only in the engine demand stage. Independent precommit literal candidate
preparation still initializes the same immediate actual-owner inspection,
deadline-bounded watcher and abort/join scope before any spool/upload/finalize I/O,
even with no selected sources. Required ordinary regression evidence includes
cancellation during stalled literal upload: owned writer/watcher cleanup is joined
without candidate/result/receipt acceptance or fabricated success.
Proposed worker-owned configuration defaults: 250 ms
control polling, 2,000 ms complete control-read budget and 30,000 ms active value
scope budget, always capped by the actual remaining database deadline. Watcher
failure fails closed; durable controls, stale revision, context abort or work
budget terminate owned object streams/evaluator work and cancel active reads.
Every exit stops timers, removes listeners and joins watcher/work/adapter cleanup.
Neither scope opens a transaction around object reads or isolated evaluation.
This watcher policy is accepted new runtime configuration, not existing behavior.

Before native value work, exact retry recovery independently checks actual
canonical delivery plus completed receipt, post-CAS revision, entire existing
transition fingerprint and serialized checkpoint/result binding. A matching
receipt alone or matching result identity alone is insufficient. Existing
`inbox_receipts` stores checksum/completion, not a historical full-plan fingerprint;
missing fingerprint proof must not be invented. Use current checkpoint/result
owner truth where it provides the exact binding, otherwise preserve the existing
stale/mismatch outcome rather than claim caller-plan acceptance. Uncertain COMMIT
is reconciled through this same owner truth, never abandonment. Same delivery with
different checksum retains delivery-mismatch handling; a changed full plan does
not receive `already_committed`. No new history/cache/proof token owner is added.

The final transaction independently reloads whole declaration and exact accepted
source IDs, versions, physical attempt or logical child-result scope, original
inline bytes, reference kind/ID, checksum/length and available artifact metadata.
Current eligibility/retention controls are re-evaluated after outside-SQL work.
Any change invalidates the local computation, which is neither transported nor
persisted as authority. Module-owned preparation binds the existing V1 result
identity and exact bytes, with pre-CAS creation/recheck and post-CAS acceptance;
the existing seal/receipt and candidate association remain atomic. Cancellation,
timeout and other non-result advances do not wait for candidate cleanup.

Expressions retain the existing bounded context contract. Validate monotonically
growing uniquely keyed decoded output context after each source to reject excess
before aggregate allocation, with equivalence tests to existing final validation
and identical typed invalid-result behavior. Original whitespace bytes remain
integrity identity, not an accidental tighter semantic input limit. No serializer,
quota, permanent retention pin, artifact reaper or activation is introduced.

No SQL registration/install, screened probe or attestation implementation is
authorized by this amendment. Native execution remains OFF; persistent source
projections, accepted associations, retention and full F08 qualification remain open.

## Context and selected direction

F08 needs reusable typed calls without copying graphs or occupying a parent
worker while a child executes. ADR012 and ADR058 count running and waiting runs,
plus committed reservations, against ordinary workspace/workflow capacity.
An unreserved queued child can therefore deadlock behind its waiting parent at
cap one. Primary selected strict independent occupancy and fail-fast admission
for the V1 proposal on 2026-10-02; this is not acceptance of every choice below.
Primary subsequently selected same-workspace callable pins, the bounded type and
expansion directions, configuration-only preview, membership-revision authority
and immutable family-deadline policy. Complete transaction/privilege design was
accepted with the independently reviewed revision above; implementation proof
remains open.

## Decision

Use same-workspace exact immutable callable-version pins and bounded typed
input/result contracts. A logical scoped call owns one durable admitted child or
definite refusal. Extend the existing pure engine, coordinator checkpoint CAS,
canonical run acceptance/reservation, event/outbox and retention owners. Never
introduce a recursive executor, public-HTTP workaround, graph copy, family
scheduler or another history authority.

A waiting parent retains ordinary active occupancy but releases its worker.
Child acceptance obtains an independent ordinary reservation atomically with
acceptance and the parent's call-control CAS, preserving queue bounds, child
workflow FIFO and workspace fairness. Otherwise commit a definite refusal with
no child accepted. Capacity refusal is ordinary required-node failure, not a
provider error or promise of deferred execution. Cap one cannot run a nested
call; any fully occupied workspace can refuse one. No automatic call retry or
new child after refusal/unknown; explicit parent replay remains a new execution.

Pin the whole acyclic dependency closure, including schema/result selector and
execution policies. Proposed bounds are depth four, 64 children/root and 1,000
expanded family node invocations, including loop products. Keep old formats and
pins immutable; stage explicit new format/policy versions rather than reinterpret
retained V1/V2 graphs or checkpoints. Use the existing Manual entry contract for
the initial callable child and do not fake child execution in node preview.

Primary clarified V1 result selection on 2026-10-02: a root-graph `node_output`
selector selects exactly one successful durable invocation of that node in the
child run, preserving its immutable scope and output reference. Zero successful
invocations (including missing/skipped/non-success) or multiple successful
branch-scoped invocations is definite `workflow.child_result_invalid`, even if
their values are equal. Do not choose the last value, deduplicate by equality,
aggregate an array or invent a selecting branch scope. Apply the declared path
and portable result contract to that one independently bounded source; a missing
path remains `workflow.child_result_missing`. Every node output referenced by an
expression has the same unambiguous-source requirement. Existing per-attempt
scope-specific mapping is unchanged. Publication rejects statically proven
ambiguity; runtime checks remain necessary when branch outcomes decide uniqueness.
This clarification is implementation guidance, not completion evidence.

Root initiation authority is durable and explicit: human-origin calls recheck
the initiating actor and the root's pinned membership role revision for fresh
child admission. Any revision change, even promotion, refuses a future child;
already accepted children are not retroactively canceled. Implemented membership
remove/rejoin/suspend/reactivate transitions advance that revision; user-global
and workspace status checks do not imply a new suspension generation.
Automated roots use admitted workspace-trigger authority, never a publisher's
session. Current child
lifecycle/compatibility, region, entitlement, capacity, FIFO and connection
policies remain enforced. Already accepted children settle after actor departure,
archive or rollback according to existing accepted-run truth.

Child deadlines never exceed their parent's absolute deadline; pin the bounded
one-hour default in the new executable family policy and accepted root, never
an ambient fallback for recovered/retained runs. Cancellation stops fresh spawn
and durably propagates to admitted children. Unknown effects outrank cancellation,
timeout and failure; final parent cancellation waits for truthful reconciliation.
Child terminal state plus a parent wakeup commits atomically, without holding
both child and parent locks. Duplicate/lost wakeups reconstruct from PostgreSQL
and resume the parent once through its own CAS.
Spawn holds a verified bounded root-to-parent lineage fence: ancestor SHARE rows
before the immediate parent's direct NO KEY UPDATE/CAS, no lock upgrade when the
root is that parent. Selected-run cancellation UPDATE serializes with this fence;
if cancel wins, no child is admitted; if spawn wins, that child is accepted work
requiring reconciliation. Terminal producers never lock ancestors while holding
their own run. Final PostgreSQL-clock checks enforce immutable ancestor deadlines.

All definite authoritative policy rejections, including those before reservation,
converge on one immutable refusal after candidate savepoint rollback. Infrastructure,
unsupported protocol/artifact and corruption failures roll back the whole outer
transaction for existing transport/CAS recovery; uncertain commit is resolved by
durable identity, never fabricated as definite refusal. Reuse the concrete
transaction-local WorkspaceTransaction adapter and canonical acceptance; a narrow
tenant-bound worker proof binds child insertion/reservation, not general dispatcher
privileges or a second admission owner.

Keep dependency versions, lineage, terminal/results and artifact references
while needed by nonterminal parents, replay-eligible history or legal hold;
extend bounded existing purge/retirement queries instead of adding a retention
owner. OFF denies new roots/publications, not compatible accepted continuation
or settlement. No production enablement or mixed-old-writer safety is claimed
without executable source-bound readiness/write-barrier and recovery proof.

The contract proposal specifies the private interface extension, transaction and
savepoint refusal behavior, proposed non-inverting lock/FIFO order, disclosure,
preview and exact verification obligations. Independent design review, primary
acceptance and release-owned integration/migration allocation are complete;
executable implementation and verification remain separate gates.

## Alternatives and consequences

- Ordinary queued child admission: rejected because it can wait behind its own
  parent and consume durable backlog without progress.
- Family exemptions or separate extra child quota: rejected for V1 because they
  change the hard meaning of active capacity and can amplify tenant work.
- Conserved-slot handoff after quiescing a parent: not selected for V1; requires
  explicit new suspended-parent accounting, parallel-branch quiescence, workflow
  slot reacquisition/FIFO and cancellation/retirement semantics.
- In-process child execution or embedding its graph: rejected because worker
  occupancy, restart identity, reusable version pins and inspection would diverge
  from existing execution ownership.

The selected direction conserves current admission guarantees and avoids a new
capacity framework, at the cost of product-visible call failures under capacity
pressure and inability to nest at workspace cap one. Durable callable pinning,
authority and retention still add necessary cross-package state and qualification;
bounded scopes and reuse do not remove those obligations.

## Native read operation and joined-cleanup clarification — ACCEPTED, 2026-10-04

Primary accepted this exact amendment after focused pinned-driver consistency and
full two-file source review. This is an accepted implementation contract, not
qualified runtime behavior. It explicitly
changes the complete-read latency contract, not existing qualified behavior.
`readTimeoutMillis` bounds usable checkout/query/reply from before acquisition.
At expiry, abort and latch the existing stop; a late reply cannot restore success,
start further value work or authorize commit/ack. Return waits for joined cleanup
under a separate single deadline beginning at the first stop/abort, never reset.

Let P be configured control-read timeout, R its actual remaining requested budget,
and K the established shared pool's positive configured acquisition timeout.
Native admission requires K <= R before checkout, otherwise fails closed without
SQL. Do not mutate shared pool options or add a shadow pool. Existing default
K=5,000 ms does not satisfy P=2,000 ms; usable native qualification requires an
explicit compatible existing operator configuration. Ordinary read/write behavior
and the three existing worker policy defaults/ranges remain unchanged.

Proposed cleanup allowance C=2P+2,000 ms (default 6,000, maximum 12,000) is a
feasibility requirement, NOT inferred or proven worst-case ownership. Nominal
read R+C is default 8,000/max 17,000 ms; whole active value budget plus the same C
is default 36,000/max 72,000 ms. No timer establishes resource termination.
Cleanup exhaustion retains ownership, surfaces operational failure and blocks
qualification; detaching pending work or returning an ordinary joined stop is
forbidden. These bounds require actual pinned-driver closure proof.

Before a client is delivered, construction remains shared-pool-owned and cannot
run native/tenant SQL. A queued request can time out after dequeue into newClient;
the pool internally releases its late client without delivering it to this caller.
Join raw checkout settlement but do not claim read-owned socket closure for that
construction. A delivered late client becomes read-owned and must be destroyed
exactly once and its terminal event joined. Do not modify private queues or tear
down the shared pool; existing runtime retains pool lifecycle ownership.

Join checked-out original query settlement, client terminal event and the owned
CancelRequest socket/event/timer, registering ownership before disposal. Use
remaining monotonic SQL operation time; no query after abort or on released client.
One actual deadline-confirmation read may run only for classification, after the
prior read joins and if remaining cleanup budget contains operation and disposal;
otherwise preserve unavailable. It cannot mint timed_out from local time or accept
late confirmation. Preserve original/mixed cleanup errors. Implement at the existing
tenant transaction module with a narrowly selected native mode, not utility families.
The companion specifies exact source/test seams, including the queued-to-newClient
race. No SQL install, screened probes, attestation crypto or native activation is
authorized by this clarification; full F08 remains incomplete.

## Call detail retirement clarification — ACCEPTED, 2026-10-04

Primary selected the direction on 2026-10-04: preserve parent/child/root and
pinned-version lineage through existing run-summary retention, without extending
payload, node or attempt detail to that period. This exact schema/maintenance
shape is **ACCEPTED by primary after full ADR/glossary delta review**. This is
decision acceptance, not executable behavior, SQL installation authority or
qualification.
The existing detail period is 30 days; the existing summary period is 90 days.
Deleting Call journals at detail expiry loses still-retained relationships;
retaining their physical-detail foreign keys instead prevents ordinary detail
destruction. Neither is the selected contract.

Keep the existing Call journal, not a second tombstone or history relation. Add
one nullable finite `detail_retired_at` timestamp. Make its three detail-owned
pointers (`node_run_id`, `declaration_attempt_id` and
`declaration_input_provenance_id`) nullable under a closed shape:

- Live detail: retirement timestamp absent and all three pointers present;
  existing exact composite provenance/declaration foreign key remains enforced.
- Retired detail: retirement timestamp present and all three pointers absent;
  only the protected retirement transition can detach them. No cascade or
  `ON DELETE SET NULL` may silently establish this state.

All other immutable journal identity remains unchanged: workspace, parent/root,
parent version, node/invocation identity, pinned callee/workflow version, depth,
deadline, definite outcome/child/version, original delivery/revision, seal and
recorded time. Existing parent/root/child/pinned-version foreign keys survive
detail retirement. These historical metadata fields are not payload, source,
transport, replay or new-child authority. There is no duplicate full fingerprint.

The existing bounded retention owner alone may perform the one-way transition,
after validating its actual batch/lease/fence, workspace control high water and
legal hold under the existing workspace-first destructive locks. Independently
derive the bounded sealed family (at most 64 Calls/65 runs). Every required family
run must be terminal and detail-expired at the actual batch cutoff; current replay
dependencies must permit destruction. An unsealed/missing/ambiguous family or
required control state fails operationally, not as expiry permission.

Use resumable dependency-ordered pages: remove eligible borrowed inputs and
accepted artifact associations; retire/detach eligible journal detail; delete
unreferenced eligible owned provenance and completed producer-candidate mappings;
then let existing node/attempt/event/checkpoint/detail-summary stages proceed.
Each operation must preserve the existing page bound, including a page limit of
one; no family-sized payload aggregate or unbounded deletion is allowed. A partly
processed family remains safe: untouched foreign keys protect unreleased detail,
while retired journal rows already refuse execution/source use. Hold or changed
control high water pauses/refuses subsequent destructive work without restoring
retired detail. Raw original bytes cannot become a hidden permanent retained copy.

Removing expired detail metadata does not delete object bytes, change artifact
status or release capacity. Those remain with the existing artifact owner, whose
bounded physical delete/HEAD confirmation precedes quota release. The stricter
unaccepted-candidate replacement cleanup rule still applies to replacement;
detail-retired completed producers cannot be reclaimed as new producers.

Every admission, execution/source, settlement and replay reader must explicitly
refuse a detail-retired journal before resolving its cleared pointers. It cannot
fabricate a missing/invalid child result, infer uncertain-COMMIT success, restore
detail or spawn a replacement. Existing authorized historical lineage reads may
show retained identities/outcome with detail unavailable. Final lineage deletion
belongs to existing summary/purge work after its actual dependency/hold checks;
its bounded deletion ordering must retain relationships for summaries still
within their retention period. It must not reconstruct a family from incomplete
links after deleting part of the relationship set.

Implementation must preserve this exact transition and independently qualify its
indexed eligibility/paging strategy and all reader exclusions. Required qualification
includes held/nonterminal/replay-protected families, partial pages and limit-one
resume, detail at 30 days with lineage at 90, summary/purge release, and no payload
or capacity resurrection. Native execution stays OFF; no screened probe, SQL
installation or new retention/history owner is authorized here.
