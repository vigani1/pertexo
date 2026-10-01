# ADR 058: Per-workflow concurrency with ordered queued admission

- **Status:** accepted — manager-reviewed first F29 slice under the product owner's instruction to proceed
- **Date:** 2026-10-01
- **Related:** ADR 012, ADR 031, ADR 049, ADR 056, ADR 057

## Decision

Add an optional current operational concurrency limit per workflow, shared across
published versions. Extend PostgreSQL's existing admission/reservation and
coordinator transition owners; do not introduce a second scheduler or Redis
capacity authority. The first slice queues overflow. Skip policies, per-trigger
defaults and separate configurable workflow queue limits remain deferred.

The existing workspace queued-run cap bounds accepted backlog. Reaching it keeps
the existing acceptance/rejection contract, including webhook atomicity and
schedule misfire handling. An exact idempotent request replay resolves before
current policy checks; a user-requested run replay is a new run.

## Policy and occupancy

The default is null: no additional workflow cap, not unlimited workspace
capacity. A positive integer cap applies to manual, API, replay, schedule and
webhook production runs. Previews are excluded. Child-workflow semantics remain
with F08; do not infer an additional child execution model.

Active means running or waiting. Retries and durable waits keep the same run's
slot. Committed dispatcher reservations also consume capacity, and must be
counted exactly once when a run becomes active. Both workspace and workflow
constraints apply atomically when granting a reservation and on queued-to-active
transition. Terminal transitions release occupancy; ordinary delivery retries
must not acquire another slot.

Setting a cap requires an active current workspace entitlement and accepts 1
through its current active-run limit. A later workspace entitlement reduction
does not rewrite the saved workflow policy; both constraints still apply.
Removing a cap is allowed without fabricating an execution entitlement. A lower
workflow cap does not cancel active runs or revoke already committed
reservations. Those reservations may transition without consuming another slot;
new reservations stop until occupancy is below the new cap. The UI explains this
grandfathering instead of promising an instantaneous reduction in active runs.

## Ordered promotion and control-path liveness

For workflows with a cap, persist an acceptance-order ticket under the existing
workspace admission serialization. Order by this ticket, not outbox availability
or worker arrival. Assign tickets to all new accepted production runs so enabling
a cap can order an existing backlog. Backfill legacy queued runs deterministically
by created-at and ID; do not claim reconstructed historical acceptance order.

Grant slots in ticket order and check order again before a queued run first
becomes active, so transport reordering cannot reverse actual start transitions.
Already reserved work at the moment a policy is enabled is grandfathered; FIFO
applies to subsequent grants. With a cap above one, start-transition order does
not imply completion or external side-effect order. With no workflow cap, retain
existing workspace fair-dispatch behavior. Do not block unrelated workflows
behind a capacity-blocked workflow.

Cancellation and deadline terminalization must remain deliverable with no free
slot and without waiting for FIFO. This exemption permits terminal processing,
not starting node/provider work. Recovery and deferral preserve tickets and
reservation identity, and cannot double-start a run. ADR056 trigger pause only
blocks new trigger acceptance: already accepted queued runs continue normally.

## Authorization and interface

Read policy through workflow:read. Mutation requires workflow:update, active
workspace, the existing CSRF and idempotency protections, independent revision
comparison and an audit fact. Stale revisions return a typed conflict. Reuse
workflow operational settings ownership; changing a limit does not republish a
workflow or modify trigger activation.

Run-history concurrency explanations require run:read and preserve existing
workflow-name disclosure rules. Report a current, timestamped blocker projection,
not a promised start time or a new terminal status. Distinguish workspace capacity,
workflow capacity and order waiting when supported by the authoritative snapshot;
do not label every queued run as workflow-limited. Settings expose only the
implemented queue behavior, with no enabled skip/queue-length placeholders.

## Implementation and release constraints

Use indexed authoritative occupancy/order reads rather than a new counter hot
row per workflow updated on every transition. Serialize settings writes with
the existing workspace admission lock. Before changing SQL, document and test
the lock order across policy, workspace counter, run/checkpoint, reservation,
outbox and recovery paths. Resolve an incompatible lock order in the design
before proceeding; do not paper over deadlocks with retries.

Additive migration and readiness precede readers/writers. New controls remain
unavailable until every serving dispatcher and worker enforces the policy;
record an executable compatibility/rollout gate, not just a UI flag. Old code
must not silently bypass a non-null cap. Rolling back while caps are configured
requires disabling new grants/draining or retaining enforcing workers until
policies are explicitly removed; never promise that dropping readers alone is
a safe enforcement rollback. No production enablement is authorized here.

## Required evidence and deferred work

Prove real PostgreSQL races for same-workflow grants, cross-workflow progress,
workspace plus workflow caps, ordered start under delayed delivery, restart and
reservation recovery, cap updates against admission, terminal cancellation and
deadlines at full capacity, and idempotent acceptance. Prove tenant/role denial,
bounded query plans and migration/old-writer compatibility. Then exercise the
authenticated settings and run-history UI against real API, worker and owned
dependencies, including cap one preventing overlap and removing the cap.

Commit coherent verified slices: decision, migration plus enforcement/tests,
then settings and reporting with integrated evidence. Keep F29's tracker explicit
that skip behavior and independent queue configuration are not delivered. F12
must be merged and its natural checks inspected before F29 release; implementation
may proceed on the reviewed F12 base while its CI runs.
