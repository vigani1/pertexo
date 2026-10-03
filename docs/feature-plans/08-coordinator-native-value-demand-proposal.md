# F08 coordinator native value demand — accepted interface

Status: **ACCEPTED — 2026-10-03, by primary after independent Spec/Standards closure,
including the literal-preparation lifetime clarification.** This is the concrete
companion to the accepted
[ADR065 amendment](../adr/065-durable-parent-child-workflow-calls.md#coordinator-native-value-demand-amendment--accepted-2026-10-03).
The accepted
[artifact ownership contract](08-subworkflow-contract-proposal.md#native-artifact-owner-contract-delta--accepted-2026-10-03)
and [F08](08-subworkflows.md) remain authoritative. This decision guides bounded
implementation; it does not claim the interfaces are implemented. No SQL, activation or screened
qualification is authorized here.

## Existing implementation being changed

`CoordinatorRunStore.loadAdvanceState` returns eagerly decoded
`state.callableCompletion`; it takes workspace/run/signal but no canonical
delivery. `coordinator-run-store-observations` reads material inside its read
transaction, although the engine only consumes it in `completeCallableTransition`
after a pure plan has `run.succeeded`, a valid declared root selector and unique
successful invocations. The recent control-priority correction skips value work
for validated cancellation/deadline but does not make other non-result transitions
demand-driven.

`commitCoordinatorAdvancePlan` calls `authenticateCoordinatorCallResult` inside
`withCoordinatorWriteClient`, after the workspace SHARE lock and before checkpoint
locking. Authentication independently loads immutable declaration/actual sources,
resolves their values and recomputes the result. Inline values work; artifacts do
not. Adding object reads or isolated expression evaluation there is not acceptable.
`persistCoordinatorCallResult` remains inline-only and records result at post-CAS
revision in the existing receipt transaction. These are real prerequisites, not
evidence that persistent native artifact execution works.

## Concrete accepted contracts

The following TypeScript is an accepted design contract, not code already exported. Shared
stop-data types belong with callable execution contracts in `workflow-model`, so
database and engine do not depend on each other or import worker implementation.
The engine owns its typed stopped-completion exception; the worker engine wrapper
converts only that exception to an explicit stopped result. Ordinary state and
integrity errors are not caught by that conversion.

```ts
type NativeCoordinatorValueOwner = Readonly<{
  workspaceId: string;
  runId: string;
  workflowVersionId: string;
  delivery: CoordinatorAdvanceDelivery;
  expectedRevision: number;
}>;

type CallableValueWorkStop =
  | Readonly<{ kind: 'canceled' | 'timed_out' }>
  | Readonly<{ kind: 'stale'; revision: number }>
  | Readonly<{ kind: 'context_aborted' }>
  | Readonly<{
      kind: 'unavailable';
      reason: 'control_read_failed' | 'value_work_timeout' | 'source_read_failed';
    }>;

type CallableMaterialDemand = Readonly<{
  expectedRevision: number;
  resultSelector: ValueSource;
  requiresRunInput: boolean;
  sources: readonly Readonly<{
    nodeId: string;
    invocationKey: string;
    output: OutputReference;
  }>[];
}>;

type CallableMaterialDemandResult =
  | Readonly<{
      kind: 'ready';
      material: Pick<WorkflowCallableCompletionMaterial, 'runInput' | 'outputs'>;
    }>
  | Readonly<{ kind: 'invalid_context' }>
  | Readonly<{ kind: 'stopped'; stop: CallableValueWorkStop }>;

type LoadCallableCompletion = (
  demand: CallableMaterialDemand,
  signal: AbortSignal,
) => Promise<CallableMaterialDemandResult>;

// Correlated fixed slot/source variants reuse the existing source grammar.
// valueIdentity has only reference kind/ID, SHA/length and fixed media type.
// No snapshot, decoded value, original serialized bytes, buffer or locator.
type NativeCallableValueIdentity = Readonly<{
  reference:
    | Readonly<{ schemaVersion: 1; kind: 'inline' }>
    | Readonly<{ schemaVersion: 1; kind: 'artifact'; artifactId: string }>;
  sha256: string;
  byteLength: number;
  mediaType: typeof WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1;
}>;

type NativeCallableValueDescriptor =
  | Readonly<{
      slot: 'run_input';
      source: Extract<NativeNodeAttemptValueSource, { slot: 'run_input' }>['source'];
      valueIdentity: NativeCallableValueIdentity;
    }>
  | Readonly<{
      slot: 'upstream_output';
      source: Extract<NativeNodeAttemptValueSource, { slot: 'upstream_output' }>['source'];
      valueIdentity: NativeCallableValueIdentity;
    }>;

type NativeCallableSourceProjection = Readonly<{
  runInput: Extract<NativeCallableValueDescriptor, { slot: 'run_input' }> | null;
  outputs: readonly Readonly<{
    invocationKey: string;
    output: OutputReference;
    valueSource: Extract<NativeCallableValueDescriptor, { slot: 'upstream_output' }>;
  }>[];
}>;
```

The source read interface belongs to the existing coordinator run-store owner:
`loadCallableCompletionSources({owner, demand, signal})`. It independently derives
the actual version's immutable declaration/selector scope and accepted sources,
then checks demand agreement. It returns a bounded exact **metadata-only** native
projection or typed stop after a short read transaction. Protected identity includes
fixed slot, actual source scope/provenance, reference kind/ID, SHA/length and fixed
media type, with at most 1,000 descriptors and the existing whole 1 MiB metadata
identity bound. Snapshot/value/original-byte/locator fields are rejected, not merely
parsed later. Run-input null means actual absence, never omitted descriptor. Only the
exact Graph2/executable3/Checkpoint3 path supplies this projection.

The accepted implementation clarification on 2026-10-04 adds the existing owner's
`readCallableCompletionSource({owner, source, signal, readTimeoutMillis})`: independently
recheck canonical current consumer/revision/controls and exact accepted source
eligibility, then return **one** protected original snapshot or typed stop. Descriptor
possession is identity, not a grant. Exact source/slot/reference/SHA/length must agree
with the private inventory before codec work. Each short tenant read is released
before hydration. Only after this decoded value passes incremental context bounds
may the next protected snapshot be fetched. A snapshot-bearing aggregate projection
would allocate all inline payloads before those bounds and is not accepted. No
aggregate original-byte cap is introduced; whitespace-rich sources with eligible
decoded context remain eligible. These ports also receive the parsed control-read
timeout covering checkout/query/reply, and must join pending reads and disposal.

Current-owner inspection is a distinct real read, not fake value loading:
`inspectCoordinatorValueReadOwner({owner, signal, readTimeoutMillis})`. It proves
actual outbox/run/version/revision/control truth and returns active with
`databaseNow`/immutable `deadlineAt`, or a typed stop. It creates/renews no lease,
claims no receipt, reads no object bytes and acquires no persistent grant. Its
actual SQL owner is not implemented or qualified by this decision.

### Demand enforcement and propagation

The core engine accepts the existing eager `callableCompletion` OR accepted
`loadCallableCompletion`. Reject both being present at advance entry, before
material/provider work, even for a literal or non-success transition. A TypeScript
union alone is insufficient; JavaScript/runtime calls also need the check.

For a native callable success, completion first validates root selector and unique
successful source bindings. Literal selectors need no provider. A nonliteral
selector invokes exactly one demand with ordered engine-derived bindings, without
creating a second plan or CAS. Ready material follows existing source/type/result
checks; the engine supplies its existing restricted evaluator, not an evaluator
returned by the provider. `invalid_context` maps only to the existing typed
`workflow.child_result_invalid` completion. `stopped` raises the dedicated typed
completion-stop exception carrying the stop data, before any success plan escapes.

`createCoordinatorAdvanceEngine` catches only this dedicated exception and returns
`{kind: 'value_work_stopped', stop}` alongside existing transition/no-change cases.
The coordinator commit result adds the same native stopped case for independently
stopped precommit work, after rollback where required. The public commit input
still contains the ordinary plan/delivery, not worker material, opaque proof or
prepared-reference grant.

The handler never commits an interrupted success plan or invents a canceled
checkpoint. Canceled/timed-out/stale/transient-unavailable work stops terminate
owned work and follow the existing authorized delivery retry/backoff/deadline
mechanism. Use a typed retryable coordinator value-work error at the queue adapter;
do not turn it into `unrecoverableQueueError`, child failure or a returned
`deferred` that would silently acknowledge a job without durable continuation.
The next authorized advance loads actual current control/checkpoint state and
settles it through the existing engine/commit owner, with no result demand.
Context abort follows existing abort/drain behavior after cleanup. Existing proven
stale/duplicate commit outcomes retain their current transport treatment; a value
work stop is not that proof.

Only known transient reads/timeouts become unavailable stops. Malformed
declaration/state, wrong delivery, accepted-source scope mismatch and codec
byte/integrity failures preserve their original operational/state errors. They
are not swallowed into semantic invalid-context or cancellation.

## One joined value-work lifetime policy

The framework value-lifetime module is composed with the existing source codec,
actual run-store owner inspector and artifact writer. Database receives a borrowed
framework dependency; it never imports worker implementation. One module owns
watcher, deadlines, stops and cleanup, not separate handler and commit policies.
It offers a callback-scoped value session with signal, bounded source reading and
result preparation; the session cannot escape its callback or become a proof token.

There are two sequential scopes, never overlapping watchers for the same local
invocation. The demand scope lives through engine material hydration and isolated
evaluation and is joined when the engine returns/stops. The independent precommit
scope starts afresh under the same actual owner, closes the inter-scope gap with
an immediate owner check, and lives through independent reads/evaluation/result
preparation and final acceptance/reconciliation. Its decoded material is private
to that commit invocation and is not reused from the worker's first demand scope.

Scope initialization is lazy: pure non-success completion creates no value work,
and a literal selector creates no provider/source/control-watcher work in the
engine demand stage only. This exemption never applies to independent precommit
literal result candidate preparation. Before any possible spool/upload/finalize
I/O, that preparation initializes the same immediate actual-owner inspection,
deadline-bounded control watcher and abort/join scope, even with no selected
sources. First actual value work performs owner inspection before any object
read/evaluator/preparation, then arms its watcher and linked deadline. Each
source/read/evaluation/preparation step checks before and after; final acceptance
always independently rechecks inside its short transaction.

### Accepted configuration and budgets

The existing worker configuration module owns parsing and forwards one policy into
coordinator runtime/composition; run-store options receive this borrowed policy
dependency, not a second independently chosen set of defaults. Proposed fields:

| Configuration | Default | Accepted range | Meaning |
| --- | --- | --- | --- |
| `WORKFLOW_NATIVE_VALUE_CONTROL_POLL_MILLIS` | 250 ms | integer 100–1,000 ms | Delay after one check finishes before the next; no overlapping queries. |
| `WORKFLOW_NATIVE_VALUE_CONTROL_READ_TIMEOUT_MILLIS` | 2,000 ms | integer 100–5,000 ms | Entire checkout/query/response budget, also applied through existing abortable checkout and tenant statement timeout. |
| `WORKFLOW_NATIVE_VALUE_OPERATION_TIMEOUT_MILLIS` | 30,000 ms | integer 1,000–60,000 ms | Whole active value scope, not a per-source allowance multiplied by 1,000. |

These accepted F08 options now have ordinary worker parsing, forwarding and operative
consumption by the lazy engine demand scope. The current production run store still
omits actual owner/inventory/per-source ports and the source codec dependency, so
first demanded native work fails closed. Independent precommit consumption and
actual persistent owner implementation/qualification remain unfinished. They
are not an activation flag. Native remains OFF. Use the smaller of remaining
scope budget and actual remaining execution deadline for every operation; further
deadline checks may shorten, never extend it. Derive remaining deadline from the
owner's `deadlineAt - databaseNow` and monotonic elapsed time, not wall-clock jumps,
writer retentionMillis or a caller timestamp. Local timer expiry is not permission
to stamp durable timeout: re-read actual control truth; only that owner can classify
timed_out. An independent work-budget expiry is retryable unavailable.

One watcher serializes checks and fails closed on timeout/network/owner refusal;
it never continues work on a failed check. Cancel/deadline/stale stops abort the
scope signal. Context shutdown aborts both scopes through the existing runtime
signal. Cleanup clears all timers, removes linked listeners, cancels active
database work through existing client disposal, destroys owned streams, terminates
owned evaluator work and joins every promise/loop before the scope returns. No
detached Promise.race loser, background cache, new global monitor or lease heartbeat.
Adapters must support this cancellation contract; ordinary tests must observe
that joined cleanup, not merely that the caller stopped waiting.

A watcher seeing the module's own successful CAS must not misclassify that revision
as stale. In precommit scope, parsed full plan fingerprint/post-revision/checkpoint
are already available: exact owner-confirmed acceptance stops further value work
and follows receipt reconciliation. Without that full match, revision change is
stale; demand scope has no complete plan proof and cannot claim already_committed.
Uncertain COMMIT does not return a fabricated control outcome: existing durable
receipt/result truth must resolve whether acceptance won.

## Receipt first, independent computation, authoritative recheck

Before source I/O, parse/validate the proposed plan as today and compute the
existing full transition fingerprint/checkpoint encoding. A short existing-owner
read validates canonical outbox identity and resolves retry truth. Only actual
completed receipt plus matching workspace/run/version, exact delivery/checksum,
post-CAS revision, full transition fingerprint and serialized checkpoint/result
binding may return already_committed without rehydration/preparation.

Current `inbox_receipts` has payload checksum/completed_at but no historical plan
fingerprint. `lockCoordinatorCommitState` recognizes exact next-revision checkpoint
and fingerprint matches and otherwise returns stale. Preserve that contract:
do not invent historical proof if the current checkpoint no longer provides the
binding. An old completed receipt can suppress repeated old value work only as
existing stale/duplicate handling permits; it cannot accept a changed caller plan.
If future durable fingerprint projection is required, it must stay with the
existing checkpoint/receipt owner in the separately reviewed 0137 candidate, not
a new history table. Same delivery with a changed checksum retains existing
delivery mismatch audit/error; changed fingerprint/checkpoint never yields
already_committed and follows existing stale/invalid-plan treatment. A result
identity digest alone never substitutes for the full plan fingerprint.

For a new succeeded result, the commit module independently loads whole immutable
callable declaration (input contract, result contract and selector), exact native
version identity, actual current owner/control truth and protected selected
accepted source inventory in a short read transaction. Derive selection from
actual declaration and facts, not proposed source IDs. Release the client, hydrate
the actual sources with the existing codec, evaluate through the actual restricted
evaluator, validate declared result/type/encoding and compare to the proposed value.
No worker source material or supplied hash is used as recomputation authority.

The same module prepares this independently computed result through existing
codec/candidate/writer seams, binding actual delivery/pre-revision, next-post
revision, immutable selector/ordered source references and byte metadata V1
identity. No public prepared-reference argument is needed. Source decode and
result spool/upload/finalize are outside SQL; source grammar/identity builder
checks remain metadata checks rather than grants.

The final short write transaction preserves accepted workspace SHARE and ordered
ancestor/run/checkpoint, candidate/provenance/artifact/capacity ordering. Recheck
actual current controls/revision/canonical delivery, full immutable declaration,
independently derived selector and every accepted source ID/version/scope/physical
attempt or logical accepted child-result binding, original inline bytes,
reference kind/ID, SHA/length and current available artifact metadata. Re-evaluate
source eligibility, compatibility and retention after outside-SQL work. Source
retirement/deletion/availability change or differing selection invalidates the
local computation; no old result is forced through CAS.

Inline bytes can be reparsed/reconciled through their existing owner. SQL cannot
derive artifact path/expression output from SHA/length/wrapper JSON. Exact immutable
accepted identity equality binds independently codec-verified outside bytes and
semantic computation to current facts; the isolated evaluator never runs inside
the transaction. This equivalence argument requires explicit design acceptance.
Local computation is discarded on disagreement and redone outside SQL only on a
later authorized delivery. It is not a persisted/transmitted verification grant.

Retain full plan/checkpoint validation, exact CAS, terminal result seal and receipt.
Atomically create accepted result provenance at post-CAS and associate the exact
available candidate; failure rolls both back. Unknown COMMIT uses receipt-first
truth. Definitive abandonment and preparation-unavailable follow the accepted
artifact/retention contract; cancel/timeout/non-result settlement does not await
cleanup or bypass hold. No extra source pins, history, quota reservation or reaper.

## Incremental context equivalence and compatibility

Direct literal/run-input/node selectors do not materialize unrelated outputs.
Expressions retain the existing `resolveWorkflowCallableResultV1` bounded output
record/context limits. After each sequential source, validate the growing decoded
record using the existing validator. Unique selected keys, immutable bounded JSON
and no removals make byte/member/depth excess monotonic; early rejection must be
equivalent to final validation and become the same typed invalid-context outcome.
No new serializer or tighter limit derived from whitespace-rich original bytes.
At most one source byte buffer is owned at a time; the bounded decoded context
must not grow to 1,000 MiB before final rejection. Keep up to 1,000 bounded descriptors
and the existing whole 1 MiB identity limit separately from semantic context limits.

Tests must compare incremental and existing final validation for exact/over byte,
depth and member bounds, escaping/integer-looking keys/NUL/supplementary characters,
rounded numeric/negative-zero values and multiple source orders. Include an
original whitespace-heavy inline source whose bounded decoded context remains
eligible. Missing/corrupt authority is not an invalid expression-context result.
Retained eager/inline engine and commit paths, original snapshot recovery and
native literal behavior remain unchanged; native provider absence fails closed.

## Required ordinary and persistent evidence

Ordinary interface tests: no demand for non-success/literal/ambiguous/missing
selection; runtime eager+demand refusal; exact scope/order and mandatory native
descriptors; typed cancel/deadline/stale/unavailable/context stops across core
engine/wrapper/handler/commit/queue; no partial success/receipt/candidate acceptance;
control-read failure, stuck stream/evaluator abort and joined shutdown; deadline
and whole-scope budgets not reset per source; own-CAS receipt reconciliation;
literal precommit preparation with no selected sources still checks actual owner
before I/O, and cancellation during stalled upload aborts and joins writer/watcher
cleanup without accepting a candidate/result/receipt or fabricating success;
exact receipt/full-fingerprint duplicate versus mismatched retry; independently
recomputed wrong worker result refused; unchanged final declaration/source
inventory versus retirement/replacement/availability race; incremental/final
context equivalence and retained eager/inline compatibility.

Persistent evidence remains separate: real current owner/source descriptors,
protected actual accepted-parent association and seals, artifact-aware completion,
receipt/CAS and retention/hold/root-parent-child/replay/purge proof through the
fresh 0137 candidate after review and safe qualification approval. Ordinary external
adapters do not close those gates. No historical 0136 install, screened retry,
attestation implementation, new production activation or full F08 claim.
