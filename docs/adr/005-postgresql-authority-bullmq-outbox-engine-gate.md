# ADR 005: PostgreSQL authority, BullMQ transport, outbox/inbox, and custom-engine go/no-go

- **Status:** accepted
- **Date:** 2026-08-18

## Context

Workflow execution has two different durability concerns. PostgreSQL must
retain the authoritative workflow definition, immutable version, run state,
events, checkpoints, waits, schedules, idempotency records, outbox records,
inbox receipts, and artifact metadata. Redis and BullMQ are useful for waking
workers and distributing immediate work, but queue state can be lost, delayed,
duplicated, or observed before a database transaction is durable.

The backend plan therefore requires the API to accept a run and publish the
initial work atomically, while allowing a dispatcher or worker to crash at any
boundary. It also requires executable Phase 0D and 0E spikes before committing
to a custom execution engine. This decision fixes the durability boundary,
message contract, retry ownership, recovery behavior, and evidence required
for that gate.

## Decision

### PostgreSQL is the authority

PostgreSQL, accessed through Drizzle and reviewed SQL migrations, is the
source of truth for control-plane and execution state. In particular, it owns
workflow versions, runs, run events, checkpoints, node attempts, waits and
schedules, cancellation, idempotency, outbox events, inbox receipts, and
artifact metadata. A worker must load the immutable workflow version and the
current checkpoint from PostgreSQL before making a state transition; a queue
payload or in-memory state is never authoritative.

The API accepts a run by inserting the queued run, its initial event, and its
`workflow.run.requested` outbox event in one PostgreSQL transaction. This closes
both failure windows: a committed run that was never queued and a queued job
whose run was not committed. A database failure pauses state transitions and
workers do not continue from stale queue data.

### Redis and BullMQ are immediate transport only

Redis is the transport backing BullMQ. It is not a workflow database, a source
of truth for waits or schedules, or the durable record of a checkpoint. Due
work is reconstructed from PostgreSQL (`resume_at` and equivalent durable
state), and Redis delayed-job state is not required for correctness.

Queue and job names are package-owned constants. Producers and consumers use
versioned contracts, and a consumer remains compatible with the supported
rolling-deployment versions. Queue operations are an optimization for prompt
delivery; replaying the PostgreSQL outbox must be sufficient to restore
delivery after Redis loss or queue deletion.

### Transactional outbox claims and leases

Every externally delivered event is written to `outbox_events` in the same
transaction as the state change that requires delivery. The dispatcher claims
a bounded batch with `FOR UPDATE SKIP LOCKED`, assigns a lease owner and
expiry, and commits the claim quickly. It then enqueues the job in BullMQ with
the outbox event ID as the BullMQ `jobId`. Only after a successful enqueue does
it mark the outbox row published.

The dispatcher may crash after enqueue and before the published update. This
is an expected duplicate-delivery case, not an exactly-once guarantee. Expired
leases are reclaimable, and an event is never silently discarded. Repeated
attempts beyond the configured threshold become an explicit operational
failure with an alert and an auditable reason; operators use supported
idempotent recovery commands rather than editing rows directly.

### Inbox receipts and request idempotency

Consumers record an inbox receipt for the pair `(consumer, message_id)` and
store the payload checksum. The receipt and the business transition are
committed in one PostgreSQL transaction. A redelivery with the same message
ID and checksum is a no-op or returns the already-recorded result. The same
message ID with a different checksum is rejected and audited as a contract,
corruption, or tampering failure; it must not be processed as a new message.

API idempotency is separate from transport deduplication. An idempotency
record is scoped by workspace, operation, and request key/hash. An exact retry
returns the existing result; reuse of the key with a different request hash is
rejected. Neither inbox receipts nor idempotency records are replaced merely
because a delivery or request was retried.

### Jobs contain versioned identifiers, never workflow data

The durable job envelope contains a schema version, job kind, job/outbox ID,
referenced identifiers (for example workspace, run, node attempt, and artifact
IDs), attempt metadata, and propagated trace context. It does not contain a
workflow graph, credentials, secrets, file contents, large JSON, or verbose
logs. Consumers validate the envelope, load authoritative state by ID, and
reject unsupported versions before changing state.

### Retry ownership and uncertain outcomes

BullMQ retry/redelivery is transport behavior only. Business retry policy,
backoff, provider error classification, node-attempt limits, and the decision
to redispatch are owned by the PostgreSQL-backed coordinator and the immutable
workflow/node definition. Provider calls use an idempotency key where the
provider supports one, and node definitions declare whether an operation is
safe, idempotent with a key, or unsafe to repeat.

Attempt work executes outside a long database transaction. A short transaction
persists bounded result references, events, and transitions. Lease heartbeats
do not assert completion. If a worker lease expires, reconciliation first
loads the persisted attempt state and applies the retry/idempotency policy; it
does not blindly repeat a side effect. When the provider outcome cannot be
determined, the run remains `outcome_unknown` until an explicit reconciliation
or operator decision, rather than claiming success or silently retrying.

### Redis loss and recovery

On Redis failure, consumers and dispatchers stop or pause safely; they do not
invent state from missing queue entries. PostgreSQL outbox rows remain durable,
leases expire and are reclaimed, and a replay/redispatch operation can enqueue
the identifiers again. On recovery, duplicate jobs are expected and are made
safe by the inbox checksum and business idempotency rules. PostgreSQL failure
has the same fail-closed posture for workers: no state transition is accepted
from a stale queue payload.

### Artifacts are references, not job payloads

Execution state and job envelopes store artifact IDs and validated object
references, including checksum, byte count, media type, and workspace scope.
Large JSON, binaries, and verbose logs use S3-compatible object storage. The
artifact flow is direct signed upload followed by a transactional finalize
that verifies metadata, checksum, size, content type, and scope. Unfinalized
objects expire through maintenance. Queue delivery never transports artifact
bytes or credentials.

### Graceful drain is part of correctness

Readiness becomes false before graceful drain. The process stops admitting new
work and stops polling or claiming new outbox/queue work, then finishes or
cancels bounded in-flight work according to its lease policy. It releases or
allows expiry of claims, flushes logs and telemetry, and closes BullMQ/Redis
and PostgreSQL resources only after the bounded drain window. A worker is not
ready while draining. Shutdown must not mark a business operation complete
merely because a heartbeat or process close occurred.

## Phase 0D and 0E proof obligations

The decision is not considered implemented by interfaces or unit tests alone.
Every spike must have a real executable fixture, an automated failure test, a
measured result, and an ADR/progress update.

### Phase 0D: transport and durability fixture

Against real PostgreSQL, Redis, and BullMQ, the fixture must demonstrate:

- atomic run acceptance and the crash window between enqueue and publishing;
- bounded `SKIP LOCKED` claims, lease expiry/reclaim, replay, and attempt
  threshold behavior;
- duplicate enqueue and exact inbox redelivery as no-ops;
- checksum mismatch rejection and request-key/request-hash idempotency;
- versioned identifier-only envelopes that contain no graph, secret, or
  artifact bytes;
- transport retries versus business retry ownership, including provider-call
  deduplication and `outcome_unknown` handling;
- Redis loss, restart, queue loss, PostgreSQL outage, and recovery from the
  durable outbox/checkpoint state;
- artifact finalize validation and reference-only job delivery; and
- readiness/drain behavior, including no new claims and bounded in-flight
  shutdown.

The fixture records the commands, dependency versions, migration head,
failure-injection point, backlog/attempt/lease metrics, and measured recovery
latency. A prose assertion that “the queue is reliable” is not evidence.

### Phase 0E: execution-engine fixture

Against the real persistence and transport seams, the engine fixture must kill
the coordinator and attempt worker at pre- and post-checkpoint boundaries and
prove that ready work is reconstructed from the immutable version and
checkpoint. It must also prove that waits survive process and Redis restart,
resume without consuming a slot while waiting, cancellation is durable,
branch/join and bounded-loop semantics are deterministic, node attempts do not
duplicate unsafe effects, and the supported expression/JSONata subset stays
bounded and deterministic. Event/SSE replay and observability context must
remain explainable after recovery.

### Phase 0D implementation evidence

Phase 0D passed on 2026-08-20 against PostgreSQL 18.6, Redis 8.2.8,
BullMQ 6.1.2, and migration head `0006_execution_vocabulary.sql`. The executable
fixtures cover atomic acceptance/outbox rollback and commit, bounded concurrent
claims, enqueue-before-mark recovery, lease ownership and exhaustion, inbox
checksum and request-hash conflicts, safe provider retry with a stable key,
unsafe `outcome_unknown`, durable artifact finalize/expiry, trace propagation,
tenant-scoped checksum audit facts, and reference-only jobs.

The destructive fixture erased isolated Redis DB 15 after enqueue-before-mark,
stopped/restarted Redis, and stopped/restarted PostgreSQL. It recovered the
erased queue from the durable outbox in 1,123.26 ms, detected Redis loss in
511.70 ms and recovered in 5,714.29 ms, and detected PostgreSQL loss in 1.14 ms
and recovered in 5,708.74 ms. Redis AOF retained an independently enqueued job.
Readiness fell before drain; the dispatcher admitted no new claim, closed in
0.89 ms, and a forced active consumer closed in 55.32 ms. Cleanup restored both
services healthy and left the isolated Redis database empty.

The operational metric seams now report fixed-cardinality outbox backlog/age,
claim size, publication/error class, lease expiry/reclaim/exhaustion, queue
depth/oldest age/stalls, dispatch latency, consumer readiness/drain, worker
process starts/restarts, active handler count, completion/failure, duration,
and tenant-scoped artifact count/bytes. The full commands and assertion counts
are recorded in
`docs/implementation-progress.md`. This evidence completes Phase 0D only; the
custom-engine decision remains gated on every Phase 0E proof below.

### Phase 0E implementation evidence and decision

Phase 0E passed on 2026-08-20 against PostgreSQL 18.6, Redis 8.2.8,
BullMQ 6.1.2, Node.js 24, OpenTelemetry API 1.9.0/SDK 0.221.0, JSONata 2.2.2,
and migration head `0007_execution_runtime.sql`. The final command matrix was:

- `pnpm install --frozen-lockfile`;
- `pnpm check`;
- `ARTIFACT_STORE_INTEGRATION=true WORKER_TRANSPORT_INTEGRATION=true
  API_SSE_INTEGRATION=true pnpm test:integration`;
- `PHASE0E_EXECUTION_INTEGRATION=true pnpm --filter @pertexo/worker
  test:phase0e`;
- `API_SSE_RESILIENCE_INTEGRATION=true pnpm --filter @pertexo/api
  test:sse-resilience`; and
- `WORKER_TRANSPORT_RESILIENCE=true pnpm --filter @pertexo/worker
  test:resilience`.

The process fixture passed five destructive assertions in 41.16 seconds. It
SIGKILLed coordinator processes after immutable-version/checkpoint recovery and
on both sides of checkpoint CAS, then proved exact fresh-process reconstruction
and stale-revision fencing without inventing a domain event. It SIGKILLed a
safe attempt worker before dispatch and idempotent-with-key and unsafe attempt
workers after dispatch; fencing retained one provider effect and persisted
truthful `outcome_unknown` where required. The database rejected live-lease
reconciliation and emitted the complete strict attempt identity after expiry.

The durable wait held no database lease or BullMQ active slot, rejected early
resume, restarted Redis in 5,976.94 ms, reached due recovery in 7,102.69 ms,
and completed in a fresh worker in 726.57 ms. Concurrent due coordinators and
duplicate production BullMQ publication produced one logical resumed attempt,
event, outbox row, and completion. Active cooperative work observed durable
PostgreSQL cancellation through an `AbortSignal` while Redis was unavailable;
recovery took 12,241.58 ms, no fresh worker could claim or admit work, and the
already completed external effect remained recorded exactly once. A separate
cancellation restart completed in 5,975.06 ms.

Persisted all/any/count joins, skipped and missing branches, and an exact
bounded loop were reconstructed from the run-pinned immutable graph plus
checkpoint across pre- and post-CAS process death, including duplicate
completion replay. Separate executable validation cases reject over-limit
loops, conflicting completion facts, and arbitrary cycles before persistence.
The resumed worker activated and exported a real OpenTelemetry consumer span
with the recovered W3C parent.
The SSE fixture detected Redis publication loss in 1.09 ms, restored Redis
health in 5,797.18 ms, and reconstructed the exact PostgreSQL sequence in
5,810.51 ms. The restricted evaluator ran 101 deterministic evaluations across
two workers and a restart in 836.15 ms, using JSONata 2.2.2 and policy V1, with
canonical result SHA-256
`43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777`.

Cleanup restored authenticated Redis `PONG`, left isolated Redis DB 15 empty,
and verified PostgreSQL health. The full repository gate passed 239 unit tests;
the normal real-service matrix passed 88 database, two object-store, one API
SSE, and five worker assertions. The final implementation review found the
measured ADR/progress record to be the only remaining gate condition.

**Custom-engine decision: GO.** The checkpointed PostgreSQL + BullMQ engine may
proceed because recovery is derived from immutable PostgreSQL state, duplicate
delivery is fenced/idempotent, waits and cancellation do not depend on Redis
authority, unsafe effects fail conservatively, and the bounded expression
runtime and recovery observability passed executable gates. The Temporal
fallback is not required at this gate; any future violation of these invariants
reopens the decision rather than weakening it silently.

## Custom-engine go/no-go and Temporal fallback

The custom engine proceeds only if all execution spikes pass with measured,
repeatable results and no behavior depends on hidden process timing, Redis-only
state, manual repair, duplicate-sensitive provider calls, or special-case
compensations. The gate includes operational recovery, not only the happy-path
state machine.

If the gate is not met, execution feature expansion stops and the team runs a
focused Temporal evaluation using the same failure fixture, node SDK boundary,
PostgreSQL data model, and event contract. The comparison covers durability,
dynamic graph/version behavior, retries and idempotency, waits and
cancellation, failure recovery, observability, operational burden, and
measured latency/cost. Switching engines requires a new accepted ADR; it does
not silently relax PostgreSQL authority or the public event contract.

## Consequences

Positive consequences:

- committed workflow state survives Redis loss, duplicate delivery, and
  worker/process crashes;
- transport can be replayed or replaced without moving authority out of
  PostgreSQL;
- retry, idempotency, artifact, and recovery behavior are explicit and
  testable; and
- the custom-engine decision is evidence-based rather than an irreversible
  assumption.

Costs and obligations:

- the dispatcher, leases, inbox receipts, reconciliation, and operational
  tooling add implementation and observability work;
- duplicate delivery and uncertain provider outcomes must be modeled in every
  side-effecting node;
- PostgreSQL carries durable execution writes and requires suitable indexes,
  bounded transactions, and capacity measurements; and
- Phase 0D/0E fixtures and failure injection are release gates, not optional
  demonstrations.

## Rejected alternatives

- Treating Redis/BullMQ as the durable workflow or schedule database.
- Enqueueing directly from the API without a transactional outbox.
- Sending complete graphs, secrets, files, or large results in queue payloads.
- Giving BullMQ ownership of business retries or declaring provider effects
  exactly-once without an idempotency/reconciliation contract.
- Requiring manual row edits as the normal recovery path.
- Proceeding with a custom engine without the Phase 0D/0E gate or selecting
  Temporal without measuring it against the same fixture.

## Supersession criteria

Revisit this ADR if the system requires a different durable authority, a
workflow engine with stronger built-in execution guarantees, multi-region
authority/sharding, a materially different transport contract, or provider
side-effect semantics that invalidate the current idempotency and
`outcome_unknown` model. Any such change requires a new reviewed ADR and
updated executable proof obligations.
