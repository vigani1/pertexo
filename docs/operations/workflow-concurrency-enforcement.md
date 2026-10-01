# Workflow concurrency enforcement

This is the implementation lock and compatibility contract for the queue-only
first slice of [ADR 058](../adr/058-workflow-concurrency-queue-admission.md).
It is not evidence of production enablement or of completed verification.

## Lock order

The existing workspace admission counter serializes acceptance, new slot grants,
first active transitions, and concurrency setting writes. Workflow policies are
separate operational rows; terminal transitions do not lock or update a workflow
policy row or introduce a workflow hot counter.

| Operation | Locks, in acquisition order |
| --- | --- |
| Acceptance | Existing compatibility/workflow publication locks; workspace and entitlement shared locks; workspace admission counter; new run/checkpoint/outbox |
| Settings | Workspace, actor/membership and workflow shared locks; command receipt; workspace admission counter; policy row; audit/receipt result |
| Dispatcher grant | Existing fair cursor and candidate outbox; workspace and candidate run `KEY SHARE SKIP LOCKED`; workspace admission counter; reservation insertion |
| Coordinator commit | Workspace shared lock; run and checkpoint `NO KEY UPDATE`; workspace admission counter for admission/status changes; reservation release, or replacement outbox and reservation rebind on deferral; receipt |
| Cancellation/deadline marking | Cancellation takes workspace shared lock before run exclusive lock and its workspace-bound audit; deadline marking owns only the run and unbound control outbox; neither takes the admission counter |
| Reservation recovery | Existing due reservation `UPDATE SKIP LOCKED`; plain run/outbox reads; new recovery outbox and reservation binding update; no admission counter or exclusive run lock |

The dispatcher must acquire the run's key-share lock **before** the counter. A
reservation's run foreign key must never wait for an exclusive run lock while
holding the counter. Coordinator `NO KEY UPDATE` retains exclusive state/CAS
ownership while being compatible with that foreign-key key-share lock. An old
coordinator using `UPDATE` is skipped before the dispatcher acquires the counter.
Recovery retains an already committed slot and never acquires the counter while
holding a reservation lock. These are ordering rules, not deadlock-retry policy.

Reservation foreign keys also reference the workspace and the candidate outbox.
The dispatcher takes workspace key-share before the run and counter, and already
owns the candidate outbox lock. Coordinators take the existing shared workspace
admission lock before any run/checkpoint lock, matching workspace-first lifecycle
and purge. Recovery creates an outbox with no aggregate run/workspace foreign key;
its reservation update changes only the outbox binding (to its own new row), not
the workspace/run keys. Settings hold workspace/workflow/actor shared locks
before receipt, counter, policy insertion and audit foreign keys. Terminal outcome
workflow foreign-key key-share locks are compatible with operational workflow
no-key-update writers; no terminal path acquires a policy row lock.

All newly accepted production runs receive a durable ticket while holding the
workspace counter. Rollbacks may leave sequence gaps; exact request replay does
not insert a run or allocate a ticket. Legacy queued rows are backfilled by
`created_at,id`; that deterministic order is not reconstructed acceptance history.
For capped workflows, grants select the oldest unreserved, non-control ticket;
first active transitions recheck earlier queued tickets. Existing reservations
are explicitly order-exempt when a cap is enabled. Lowering never revokes a
committed reservation. Cancellation/deadline controls remain dispatchable without
a new slot and cannot authorize node execution.

FIFO capacity deferral completes the consumed receipt only after rebinding any
matching committed reservation to the replacement outbox in the same transaction.
The worker-only, tenant-bound helper validates the queued run and both authoritative
delivery identities. It changes only the outbox binding and clears the recovery
timer; slot identity, creation time, recovery count, ticket and order exemption
remain unchanged. A stale delivery cannot steal a newer recovery binding. Receipt
completion then releases only the old binding, while actual starts and terminal
commits retain their existing release behavior.

## Executable compatibility boundary

The additive migration must be installed before readers or writers. Exact schema
head and function/index/ACL readiness checks reject an old artifact at startup.
New dispatcher and coordinator write transactions install the transaction-local
`app.workflow_concurrency_protocol=1` marker. Database admission functions and the
run transition trigger require that marker whenever a non-null workflow policy
could admit new active work. Old already-running writers fail closed; a UI flag
or startup-only check is not the enforcement boundary.

Direct active INSERTs check configured caps both before and after acquiring the
workspace counter. The second check observes a cap committed while an INSERT
waited on a settings transaction; an absent marker rejects with `PTC01`, and a
marked direct INSERT rejects with `PTC02` because capped work must enter the queue.

A missing marker on a coordinator capacity check raises before taking the counter
instead of being treated as ordinary deferral. This rolls back the old run lock
and avoids a capacity-deferral/release cycle. Already-active work and queued
terminal control transitions can drain without granting new workflow work.

The marker is a compatibility declaration by trusted runtime code, not actor
authorization or proof that every process in a fleet has upgraded. Tenant scope,
binding, occupancy, FIFO and current policy are checked in SQL independently of
it. Deployment must quiesce old grant owners, install the migration, start and
verify enforcing artifacts, then enable positive policies. Mixed-version tests
must prove old reserve/helper/direct-transition paths cannot bypass a cap;
mixed deployment liveness is not promised.

Rollback with positive policies requires stopped grants and drained reservations,
or retaining the enforcing artifacts until policies are explicitly removed. Do
not roll back to an old grant owner with configured caps. Production enablement,
F12 release, and fleet coordination remain release-owner responsibilities.

## Required evidence

Before this slice is declared complete, record real PostgreSQL lock races,
reservation recovery/restart and query plans; migration/old-writer/readiness
checks; current-policy/CAS/idempotency/tenant authorization checks; and a real
API/worker/browser proof that a cap of one prevents overlap and removal restores
workspace-controlled starts. Mocked UI tests are not the runtime proof.

## Required browser CI owner

The [browser job](../../.github/workflows/ci.yml) explicitly runs
`test/workflow-concurrency-browser.integration.test.ts` with
`WORKFLOW_CONCURRENCY_BROWSER_INTEGRATION=true`. It builds the API and worker
dependency closures after installing browsers, starts PostgreSQL/Redis in its
unique Compose project, validates the JSON report with the existing strict
Vitest gate validator (at least one passing test, zero skipped/pending/todo),
uploads the report, and always tears down its owned services. Ordinary API CI
and the mirrored local-quality cohort exclude this opt-in file; discovery with
the flag disabled is not acceptance evidence.

The fixture requires all eight explicit database role URLs and `REDIS_URL`,
with loopback endpoints matching explicit `POSTGRES_PORT`/`REDIS_PORT`. Its
`WORKFLOW_CONCURRENCY_COMPOSE_PROJECT` must equal `COMPOSE_PROJECT_NAME` and name
the exact CI browser project, or a bounded task-local
`pertexo-concurrency-browser-...` project. Before acquisition, database drop,
and Redis cleanup approval, read-only Docker attestation verifies one exact
container per service, running state, project/service labels, and a single
matching loopback binding. A missing or mismatched ownership selector fails
closed. The original exact local-container attestation remains available when
no Compose project is configured; neither mode adopts everyday services.

Run the exact fixture after `pnpm --filter @pertexo/api... build` and
`pnpm --filter @pertexo/worker... build`, with Chromium installed and
`API_IDENTITY_INTEGRATION=true`. Use the same explicit ownership selector and
role/port configuration for the fixture and for the project's lifecycle.
Only the owner that created that isolated project may run its cleanup.
