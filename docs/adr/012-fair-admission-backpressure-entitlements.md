# ADR 012: Fair admission, backpressure, and workspace entitlements

- **Status:** accepted
- **Date:** 2026-08-25

## Context

Production triggers must survive bursts without allowing one workspace to
consume the shared worker queue. Quotas, fair selection, ingress limits, and
transport capacity are different controls. Redis queue state cannot provide
authoritative entitlement or admission decisions after loss or redelivery.

## Decision

PostgreSQL is authoritative for versioned workspace entitlements, accepted-run
counts, and admission. V1 defaults are five active runs and 100 queued runs per
workspace. An active run is in `running` or `waiting`; a queued run is an
accepted run in `queued`, awaiting fair admission. Durable trigger deliveries
that have not accepted a run remain trigger backlog and do not silently consume
a queued-run slot.

An exact idempotent replay resolves to its previously committed result before
current quota evaluation. A new acceptance transaction locks the applicable
entitlement and counters and either commits the run or rejects it; Redis may
accelerate known rejections but never grants capacity. Retries remain part of
their active run and consume the same workspace allowance as first attempts.

Workspace active and queued limits, ingress rate limits, provider-connection
limits, and global worker capacity are enforced independently. Passing one does
not imply passing another. Preview and test work sheds before production work.
An interactive request rejected by a hard admission limit returns `429` with a
bounded `Retry-After`.

Durable trigger work may remain pending in a bounded backlog rather than being
dropped. Dispatch throttles and alerts visibly when its configured backlog-age
bound is exceeded. A webhook returns `202` only after one accepted run and its
required event and outbox records commit atomically; pending or rejected work is
not represented as an accepted run.

The generic webhook is an interactive hard-admission path: if its workspace
queued-run cap or ingress limit is exhausted, the API persists no delivery or
run and returns `429` with `Retry-After`; an exact sender retry may later be
accepted. Durable pending backlog applies to schedule occurrences and future
provider-owned deliveries that already exist independently of an HTTP request.
It does not turn a rejected generic webhook into asynchronous accepted work.

The PostgreSQL dispatcher selects at most one eligible queued item per workspace
in each fairness round, using row locks with `FOR UPDATE SKIP LOCKED`. Durable
workspace cursor and ordering state makes rounds restartable and prevents a
process restart from resetting selection to the same workspace. BullMQ receives
only admitted identifier-only work and is not admission authority.

## Consequences

One tenant cannot monopolize shared delivery, and Redis loss cannot create
capacity or erase accepted work. Independent limits remain observable and
tunable. The trade-off is transactional contention around entitlement and fair
dispatch state plus a durable trigger backlog distinct from accepted runs.

## Rejected alternatives

- Global FIFO across all workspaces.
- Paid-tier priority as the sole ordering rule.
- Redis counters, BullMQ depth, or worker-local state as quota authority.
- Treating autoscaling as admission control.
- Granting on a cache miss or reconciling over-admission later.
- Consuming new quota before recognizing an exact replay.
- Returning webhook `202` before an accepted run commits.
