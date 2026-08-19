# ADR 007: Run and node state, retry, idempotency, and unknown outcomes

- **Status:** accepted
- **Date:** 2026-08-20

## Context

ADR 005 makes PostgreSQL authoritative and BullMQ transport-only. ADR 006
separates checkpoint coordination from node-attempt execution. The remaining
failure boundary is an attempt worker disappearing before, during, or after an
external call. Queue redelivery, a configured node retry, and a user replay
must not become three names for blindly repeating that call.

## Decision

### Persisted state machines

The execution domain owns separate transition policies for runs, logical node
invocations, and their attempts. A transition and its sequenced event commit in
the same workspace transaction. Terminal facts are immutable.

| Aggregate | Allowed transitions |
| --- | --- |
| Run | `queued -> running`; `running -> waiting`; `waiting -> running`; `queued|running|waiting -> canceled|timed_out`; `running|waiting -> succeeded|failed|outcome_unknown` |
| Node run | `pending -> ready|skipped|canceled`; `ready -> running|skipped|canceled`; `running -> waiting|succeeded|failed|canceled|timed_out|outcome_unknown`; `waiting -> ready|canceled|timed_out|outcome_unknown` |
| Node attempt | `pending -> ready|canceled`; `ready -> running|canceled`; `running -> succeeded|failed|canceled|timed_out|outcome_unknown` |

`node_runs` is one deterministic logical invocation, identified by the run and
an `invocation_key` derived from node, branch, and iteration scope.
`node_attempts` is immutable history for that invocation. A retry creates the
next attempt number; it never moves a failed attempt back to `ready` or
`running`. A node run in `waiting` has a PostgreSQL `resume_at` and no active
attempt or occupied worker slot. When it becomes due, the coordinator moves it
to `ready` while atomically admitting the next attempt and its outbox event.

The coordinator alone moves run state, creates node runs and attempts, moves a
node run to `ready`, `waiting`, or `skipped`, and derives aggregate terminal
state. An attempt worker may claim `ready -> running` and record exactly one
terminal attempt outcome. Its completion transaction updates the node run only
when the attempt is still the current admitted attempt and emits a coordinator
continuation. Neither a queue consumer nor a provider adapter finalizes a run.

Run terminal state is derived deterministically. Any required invocation with
an unresolved possible effect makes the run `outcome_unknown`. Otherwise a
durable cancellation request produces `canceled` after all admitted work is
reconciled; an expired run deadline produces `timed_out`; an unhandled node
failure produces `failed`; and only completed required invocations with no
unhandled failure produce `succeeded`. `skipped` is a coordinator fact for an
unreachable or disabled invocation, not an attempt outcome.

### Dispatch evidence and side-effect classes

Every executable operation is pinned with exactly one side-effect class:

- `safe`: repeating the operation cannot create or change an externally
  visible effect;
- `idempotent_with_key`: the provider contract deduplicates the exact logical
  operation when the same key is reused; or
- `unsafe`: dispatch may create an effect and neither a stable idempotency key
  nor authoritative provider reconciliation makes repetition safe.

Before an external call, the worker commits a dispatch marker, dispatch time,
side-effect class, stable provider key when applicable, and a lease fencing
token on the running attempt. This is deliberately conservative: for an unsafe
operation, a crash after the marker is committed is treated as possibly
dispatched even if the process died before bytes reached the provider. The
platform prefers an explicit unknown outcome to a duplicate effect.

For `idempotent_with_key`, the provider key is created once when the logical
node run is admitted and persisted before dispatch. It is a versioned,
provider-compatible digest of the run ID, invocation key, pinned operation
identity, and product namespace. Queue redeliveries and every logical retry of
that invocation reuse the same key. A replay has a new run ID and therefore a
new key. Adapters must not silently substitute a random request ID or attempt
number for this key.

Provider responses are classified once at the adapter boundary as success,
definite failure, retryable definite failure, or ambiguous. Bounded output or
safe error references are committed with the attempt outcome. An ambiguous
result after possible dispatch is handled as follows:

- `safe` work may be redelivered or retried within policy;
- `idempotent_with_key` work may be queried or repeated with the same key
  within policy; and
- `unsafe` work becomes `outcome_unknown` without another automatic call.

`outcome_unknown` is a terminal historical fact for the attempt, node run, and
derived run. An operator may append reconciliation evidence and explicitly
start a replay, but cannot rewrite the original execution as if uncertainty
never existed.

### Redelivery, retry, and replay ownership

The three repetition mechanisms have different identity and owners:

| Mechanism | Identity | Owner | Effect on persisted history |
| --- | --- | --- | --- |
| Queue redelivery | Same job and attempt ID | Transport consumer plus attempt reconciler | No new logical attempt; completed or currently leased work is a no-op |
| Logical retry | Same node run, next attempt number | Coordinator retry policy pinned by the node definition | Prior attempt stays terminal; new attempt and due time are committed |
| User replay | New run ID | Executions application command | Original run is unchanged; selected original or current workflow version is explicit |

BullMQ backoff and delivery counts never decide business retry eligibility.
The coordinator applies the pinned maximum-attempt, error-class, timeout, and
bounded exponential-backoff policy. A delayed retry is stored as a due time in
PostgreSQL and delivered through outbox after it becomes due; correctness does
not depend on a BullMQ delayed job.

Request idempotency is separate from both transport deduplication and provider
idempotency. Run acceptance and replay commands claim a workspace-, operation-,
and scope-specific request key with a canonical request hash. An exact retry
returns the same run; the same key with a different hash is rejected. A cancel
command is idempotent for the same run and cancellation intent, but cannot
change a terminal run or replace previously committed cancellation metadata.
Inbox receipts deduplicate one message delivery and do not substitute for
either command or provider keys.

An exact queue duplicate first checks the inbox checksum and persisted attempt.
If the attempt is terminal or has an unexpired lease, it performs no provider
call. After lease expiry, reconciliation may redeliver the same attempt only
when no dispatch marker exists or when its `safe` or `idempotent_with_key`
contract permits it. A definite retryable failure closes the current attempt
and lets the coordinator create a new one. An unsafe attempt with possible
dispatch is never automatically redelivered or converted into a logical retry.

### Leases and reconciliation

Claiming an attempt atomically sets `running`, a lease owner, expiry, and a
monotonically increasing fencing token. Only that owner and token may heartbeat
or commit the attempt result. Heartbeats extend bounded ownership; they are not
evidence that dispatch occurred or that the provider completed work.

An expired lease authorizes reconciliation, not blind execution. The
reconciler locks the attempt, reads its terminal state, dispatch evidence,
side-effect class, provider key/reference, cancellation state, and retry
policy, then makes one compare-and-swap decision:

1. do nothing for an already terminal attempt;
2. reclaim/redeliver work that is provably not dispatched;
3. safely query or repeat `safe` or `idempotent_with_key` work;
4. record a definite provider result; or
5. record `outcome_unknown` when an unsafe dispatched result cannot be proved.

Incrementing the fence prevents a stale worker from committing after
reconciliation. It cannot undo an external effect, so provider calls also
receive the stable key where available. Reconciliation emits the same domain
outcome vocabulary as normal completion plus safe reconciliation metadata; it
does not invent a second completion path.

The crash-boundary fixture therefore has deterministic expectations: failure
before the dispatch-marker commit is reclaimable without an assumed call;
failure after that commit but before or after the provider call follows the
side-effect class and is conservatively unknown for unsafe work; and failure
after the outcome commit but before queue acknowledgement is an exact
redelivery no-op.

### Truthful cancellation

Cancellation first commits `cancel_requested_at`, actor/reason metadata, and
`run.cancel_requested`. Redis may accelerate notification, but PostgreSQL is
the cancellation authority. Every coordinator decision checks it before
admitting work, and no new attempt may be admitted after it is observed.
Running executors receive an `AbortSignal` and stop cooperatively.

Cancellation does not erase completed effects or turn an ambiguous effect into
`canceled`:

- an attempt not yet possibly dispatched may become `canceled`;
- a provider-confirmed success remains `succeeded` and its output/effect stays
  recorded;
- a provider-confirmed absence or abort may become `canceled`; and
- a possibly completed unsafe effect becomes `outcome_unknown`.

The run becomes `canceled` only after scheduling has stopped and every admitted
attempt is terminal or reconciled with no unknown outcome. If run completion
commits before the cancellation command obtains the run lock, the terminal run
is not cancelable. If cancellation commits first, a later worker result is
still recorded truthfully and the coordinator applies the cancellation
precedence above.

### Event vocabulary and invariants

Phase 0E fixtures use the versioned facts `run.queued`, `run.started`,
`run.waiting`, `run.cancel_requested`, `run.succeeded`, `run.failed`,
`run.canceled`, `run.timed_out`, `run.outcome_unknown`, `node.ready`,
`node.started`, `node.progress`, `node.waiting`, `node.retry_scheduled`,
`node.succeeded`, `node.failed`, `node.skipped`, `node.canceled`,
`node.timed_out`, and `node.outcome_unknown`. `node.failed` means the logical
node run is terminal; a retryable failed attempt instead records its attempt
identity and safe failure class in `node.retry_scheduled`. Node facts carry
node-run ID, invocation key, attempt ID/number when applicable, and bounded
reason or output references. They never contain credentials, provider response
bodies, or large output values.

The implementation and failure fixtures must preserve these invariants:

- each run has one immutable workflow-version ID and one current checkpoint
  revision;
- `(run_id, invocation_key)` and `(node_run_id, attempt_number)` are unique,
  attempt numbers increase without overwriting history, and at most one
  attempt per node run is nonterminal;
- each accepted state change, its gapless run event sequence, checkpoint CAS,
  and required outbox rows commit atomically;
- a terminal attempt, node run, or run never returns to a nonterminal state;
- success is proved by a committed outcome, never by output presence, a
  heartbeat, an acknowledged BullMQ job, or a missing Redis job;
- dispatch evidence and the stable provider key commit before the external
  call, while its outcome commits afterward in a short transaction;
- duplicate deliveries cannot create a duplicate logical attempt, event,
  usage charge, or provider call outside the declared side-effect policy;
- waits and retry due times release worker capacity and remain reconstructable
  from PostgreSQL; and
- crash recovery reaches one truthful terminal or continuable state without
  manual row repair or an unclassified side effect.

## Consequences

The engine can test every crash boundary using persisted evidence rather than
process timing, and operators can distinguish recovery delivery from business
retry and user replay. Stable keys make supported provider effects repeatable,
while unsafe ambiguity remains visible instead of being hidden by optimistic
retry.

The cost is additional attempt history, dispatch markers, fence-aware leases,
explicit reconciliation, and conservative `outcome_unknown` results. Provider
adapters cannot become publishable until their side-effect class, stable-key
behavior, ambiguity classification, cancellation behavior, and failure
fixtures satisfy this decision.

## Rejected alternatives

- Treating a BullMQ attempt count as the node retry policy.
- Reusing one attempt row for retries or resetting a terminal run for replay.
- Retrying every provider call after an expired worker lease.
- Marking a run canceled before active or possibly completed effects are
  reconciled.
- Promising exactly-once external side effects without a provider-enforced
  idempotency or reconciliation contract.
