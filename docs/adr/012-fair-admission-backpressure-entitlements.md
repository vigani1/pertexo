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

### Short-window abuse limits are distributed and policy-owned

Durable business quotas above remain PostgreSQL-authoritative. Short-window
request and provider-call abuse limits are a separate Redis-backed control with
one versioned policy vocabulary. One atomic operation evaluates every applicable
dimension before incrementing any of them, so concurrent requests cannot exceed
the declared threshold and a rejected workspace dimension does not partially
consume an actor or connection dimension. Redis keys contain only SHA-256
digests of normalized identifiers and expire with their fixed window.

V1 endpoint classes and one-minute defaults are:

| Endpoint class | Dimensions and limits | Backend failure |
| --- | --- | --- |
| `identity_start` | client address 10; normalized origin 30 | fail closed |
| `identity_callback` | client address 30; normalized origin 60 | fail closed |
| `authenticated_read` | actor 600; workspace 1,200 when scoped | fail open |
| `ordinary_mutation` | actor 120; workspace 300 when scoped | fail closed |
| `workflow_compile` | actor 30; workspace 60 | fail closed |
| `run_admission` | actor 60; workspace 120 | fail closed |
| `preview_test` | actor 20; workspace 40 | fail closed |
| `connection_mutation` | actor 30; workspace 60; connection 10 when selected | fail closed |
| `provider_test` | actor 10; workspace 20; connection 5 | fail closed |
| `trigger_mutation` | actor 60; workspace 120 | fail closed |
| `provider_execution` | workspace 300; connection 60 | fail closed before provider I/O |

The generic webhook keeps its existing PostgreSQL-authoritative endpoint ingress
limit because authentication, replay admission, and accepted-run truth already
commit together. Health endpoints are exempt. Every other HTTP route must map to
exactly one bounded class; an unclassified route fails startup contract tests.
Fresh idempotency keys do not change limiter keys.

The API enforces request limits after authentication/authorization guards but
before controller work, so actor identity is authoritative and expensive KMS,
provider, compilation, count, and queue operations have not begun. Identity
routes use the effective client address and normalized `Origin`; an absent or
invalid origin maps to a fixed sentinel rather than bypassing the dimension.
Forwarded addresses are accepted only when the application is configured to
trust exactly one ingress hop, and deployed networking must restrict that hop to
the load balancer. Direct deployments trust no forwarded headers. This ingress
assumption is a versioned deployment contract and is validated in rendered task
and local configuration tests.

Interactive rejection uses the non-resource-specific
`request.rate_limited` problem code and a bounded `Retry-After` of 1–60 seconds;
it never identifies which actor, workspace, connection, or resource dimension
was exhausted. Metrics contain only endpoint class, dimension kind, outcome,
and fail-open/fail-closed policy. Raw identifiers and Redis keys are never metric
attributes or logs.

Reads fail open during limiter-backend failure to preserve safe visibility.
Identity, mutation, preview, connection, trigger, run-admission, and provider
execution classes fail closed because their abuse, cost, or side-effect risk is
greater than their temporary availability. Autoscaling and WAF rules may shed
earlier, but they are defense in depth and never replace this application
control.

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
