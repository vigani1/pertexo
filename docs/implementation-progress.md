# Backend Implementation Progress

Last updated: 2026-08-20

This file tracks delivery against
[the authoritative backend plan](./workflow-platform-backend-plan.md). A phase
is marked complete only when all of its plan requirements and applicable
vertical-slice completion criteria have passed. Commits or scaffolding alone do
not complete a phase.

## Status summary

| Checkpoint | Status | Evidence |
| --- | --- | --- |
| Phase 0A — repository and process skeleton | Complete | ADR 001; commits `8d064cd`, `c80a70c`; `pnpm check`; compiled API and worker smoke checks |
| Phase 0B — PostgreSQL tenancy and RLS proof | Complete | ADR 003; commits `bad4b9e`, `9b4f6a4`, `a3bec51`, `6458fd4`; PostgreSQL 18.6 clean migration; 31 RLS integration tests |
| Phase 0C — HTTP and observability foundation | Complete | Commit `e8093d2`; 47 API/worker/observability tests; compiled role and OTLP trace/metric smoke checks |
| Phase 0D — queue, outbox, and duplicate-delivery proof | Complete | ADRs 005–006; migration head `0006_execution_vocabulary.sql`; 158 unit, 76 real integration, and one destructive recovery assertion |
| Phase 0E — execution durability proofs and engine gate | Not started | — |
| Phase 1 — identity/workspace vertical slice | Not started | — |
| Phase 2 — workflow authoring vertical slice | Not started | — |
| Phase 3 — first executable-node slice | Not started | — |
| Phase 4 — first side-effecting integration slice | Not started | — |
| Phase 5 — orchestration slice | Not started | — |
| Phase 6 — V1 providers and triggers | Not started | — |
| Phase 7 — production operations | Not started | — |

The `0A`–`0E` checkpoints are implementation-sized subdivisions of the plan's
single Phase 0. They do not alter the authoritative scope. Phase 0 remains
incomplete until every required Phase 0 foundation, executable spike, measured
result, and custom-engine go/no-go condition has been completed.

## Phase 0A — Repository and process skeleton

Status: **Complete**

- [x] Accept ADR 001 before repository conversion.
- [x] Create the pnpm monorepo foundation without speculative empty packages.
- [x] Establish the strict shared TypeScript safety baseline.
- [x] Add independently buildable NestJS API and standalone worker roles.
- [x] Parse API and worker configuration into immutable typed values.
- [x] Add conservative API liveness without false dependency-readiness claims.
- [x] Enable graceful process shutdown behavior.
- [x] Add formatting, linting, production/test type checking, tests, builds, and
      an applicable CI workflow.
- [x] Verify the compiled API health route and long-lived compiled worker.

Evidence:

- ADR: [ADR 001](./adr/001-modular-monolith-monorepo-api-worker.md)
- Commits: `8d064cd`, `c80a70c`
- Verification: `pnpm check`
- Tests: five API tests and four worker tests

## Phase 0B — PostgreSQL tenancy and RLS proof

Status: **Complete**

- [x] Accept ADR 003 before the first tenant repository.
- [x] Add local PostgreSQL infrastructure and typed database configuration.
- [x] Create the database package and reviewed migration foundation.
- [x] Define migration, owner, maintenance, API runtime, and worker runtime
      roles.
- [x] Implement transaction-scoped workspace context using transaction-local
      `set_config` on one checked-out pool client.
- [x] Prove cross-workspace reads and writes fail.
- [x] Prove pooled connections cannot leak workspace context after commit,
      rollback, sequential reuse, or concurrent transactions.
- [x] Prove runtime roles cannot own or bypass protected tables and policies.
- [x] Add honest PostgreSQL readiness and migration compatibility checks.
- [x] Record the executable fixture, automated failure tests, measured result,
      and ADR update required by the Phase 0 spike.

Evidence:

- ADR: [ADR 003](./adr/003-workspace-tenancy-rls-runtime-roles.md)
- Commits: `bad4b9e`, `9b4f6a4`, `a3bec51`
- Fixture: `app.rls_probe_records`, migrated by reviewed revision
  `0000_rls_probe.sql` (SHA-256
  `a9e66a49374d9d36caa374d76cb8a8016ba31c36155755584511bbd1366d9ac8`)
- Database: PostgreSQL 18.6 (`postgres:18`), `max_connections=100`, server
  `row_security=on`, separate non-superuser/non-`BYPASSRLS` serving roles
- Verification: `pnpm check`; `pnpm test:integration`; clean-volume
  `docker compose up -d --wait postgres`; compiled API liveness/readiness and
  compiled worker startup smoke checks
- Tests: 3 database unit tests, 31 PostgreSQL integration tests, 7 API tests,
  and 5 worker tests
- Measured pool result: the 31-test PostgreSQL suite completed in 424 ms; a
  single-client pool retained no tenant value after commit or rollback, and
  two simultaneous scoped transactions on a two-client shared pool observed
  only their own workspace rows
- Drift exercises: readiness rejected a missing policy, removed forced RLS,
  an incompatible migration head, and an incompatible runtime grant
- Review: independent standards/spec review findings were resolved by removing
  session-level context clearing, parameterizing role names, expanding schema
  compatibility checks, and adding rollback/concurrency/role-assumption tests

## Phase 0C — HTTP and observability foundation

Status: **Complete**

- [x] Add request IDs and explicit actor/workspace request context.
- [x] Add the global RFC 9457 problem-details mapping seam.
- [x] Add structured logging and redaction rules.
- [x] Add OpenTelemetry trace/metric bootstrap for API and worker roles.
- [x] Add dependency-aware readiness and graceful drain behavior.
- [x] Add package direction and server-only export enforcement as packages are
      introduced.

Evidence:

- Commit: `e8093d2`
- Verification: `pnpm check`; `pnpm test:integration`;
  `pnpm install --frozen-lockfile`; compiled API and worker startup plus
  `SIGTERM` shutdown smoke checks
- Tests: 17 observability tests, 22 API tests, and 8 worker tests; the existing
  3 database unit tests and 31 PostgreSQL integration tests also remained green
- HTTP boundary: validated/generated request IDs, immutable explicit
  actor/workspace context, global `application/problem+json` responses with
  stable `urn:pertexo:problem:*` types, bounded safe fields, and correlated
  problem logs
- Logging: fixed service/event fields, trace/span correlation, bounded recursive
  field and `Error` cause/stack sanitization, secret-header/DSN redaction, and
  unsafe event-name replacement
- Telemetry: API and worker start OpenTelemetry before instrumented framework
  imports; disabled mode creates no SDK; an enabled compiled API smoke exported
  15,011 bytes to `/v1/traces` and 19,464 bytes to `/v1/metrics` through a local
  OTLP/HTTP capture server
- Readiness and drain: both roles reject incompatible database migrations at
  startup; API readiness includes bounded PostgreSQL connectivity and drain
  state; worker admission/readiness composes database and drain state; lifecycle
  tests prove draining begins before resources close
- Boundaries: ESLint enforces package/application direction, every
  observability runtime entry has a Node guard and browser exclusion, and a
  package-contract test covers all exported subpaths
- Review: two independent Phase 0C reviews were run; findings for startup
  compatibility, bootstrap cleanup, generic HTTP mapping, worker drain wiring,
  server-only subpaths, and deep/free-text error redaction were resolved before
  completion

## Phase 0D — Queue, outbox, and duplicate-delivery proof

Status: **Complete**

- [x] Accept ADR 005 before execution persistence.
- [x] Add local Redis and BullMQ infrastructure.
- [x] Add versioned identifier-only job contracts.
- [x] Implement transactional outbox claiming and publication.
- [x] Implement idempotent consumer/inbox behavior.
- [x] Prove duplicate delivery cannot duplicate logical attempts, events, usage,
      or provider calls beyond documented retry semantics.
- [x] Add local S3-compatible storage and bounded artifact plumbing, including
      transactional finalize metadata and unfinalized-upload expiry.
- [x] Align persisted execution statuses with the plan's normative vocabulary.
- [x] Wire worker-start and artifact inventory metrics to production state.

Evidence:

Completion review on 2026-08-20 kept this checkpoint open until real
queued-run/event/outbox acceptance, transactional artifact availability/expiry,
propagated queue trace context, checksum-mismatch audit facts, and the remaining
required operational metrics were all backed by executable evidence. Those
gaps are resolved below.

- ADR: [ADR 005](./adr/005-postgresql-authority-bullmq-outbox-engine-gate.md)
- Commits: `ec8cba7`, `737017d`, `7d08961`, `d7febb4`, `b5e0382`,
  `cd58c6b`, `cc75181`, `164bc01`, `a8b3ce7`, `693d6bc`, `c472347`,
  `bd7f120`, `98a3e7a`, `68c8de4`, `b59b22d`, `4b9321a`, `c5b77be`,
  `7657d00`, `b63a18c`, `0d034d0`, `a29164e`
- Infrastructure: exact `redis:8.2.8-alpine` and `adobe/s3mock:5.1.0`
  images start healthy on loopback-only ports; Redis rejects unauthenticated
  access, reports AOF `everysec` plus `noeviction`, and retained a probe value
  across a container restart
- Persistence: a zero-state migration applied `0000_rls_probe.sql` through
  `0006_execution_vocabulary.sql`; forced-RLS outbox, inbox, artifact, audit,
  workflow-run, event, checkpoint, and idempotency tables; a
  non-superuser/non-`BYPASSRLS` dispatcher role with outbox `SELECT` and
  lifecycle-column `UPDATE` only; artifact serving roles have lifecycle-column
  `UPDATE` only and cannot rewrite identity/integrity metadata; 4 KiB
  database-enforced queue payloads; canonical SHA-256 checksums; bounded
  `SKIP LOCKED` claims; conditional lease-token publication; retry,
  expiry/reclaim, and atomic claim-time/release-time exhaustion behavior
- Contracts/runtime: four fixed queues and jobs with strict versioned Zod
  identifier-only envelopes; package-owned producer/consumer defaults;
  consumer timeouts, abort, bounded drain, and unrecoverable-error policy;
  worker startup gates the database and Redis before starting claims and closes
  all dependencies on bootstrap failure
- Duplicate proof: real PostgreSQL, Redis, BullMQ workers, and a fake HTTP
  provider prove inbox checksum conflicts, concurrent redelivery, rollback,
  one logical attempt/event/usage/provider intent, same-key safe retry with two
  HTTP requests but one accepted effect, and unsafe ambiguity with one request,
  persisted `outcome_unknown`, and no automatic retry
- Request acceptance: the production database use case atomically commits a
  queued workflow run, sequence-1 acceptance event, revision-0 checkpoint, and
  `advance-workflow-run` outbox row; rollback, exact retry, request-hash
  conflict, concurrency, RLS, and privilege tests use real PostgreSQL
- Artifacts: production metadata transitions pending uploads to available only
  after exact S3 checksum/metadata/scope validation; database-clock expiry,
  concurrent `SKIP LOCKED` discovery, crash-safe cleanup resumption, and durable
  deletion are proven; BullMQ receives only workspace, artifact, outbox, and
  schema identifiers, never bytes, graphs, secrets, checksums, media types, or
  signed URLs
- Tracing/metrics: validated W3C trace context is extracted and activated around
  the real queue-handler race, including coordinator/provider redelivery;
  fixed-cardinality OpenTelemetry instruments cover outbox backlog/age, claim
  size, publication/error class, dispatch latency, lease events, queue
  depth/age/stalls, consumer readiness/drain, active handlers, handler outcomes,
  duration, and artifact count/bytes; metric failures cannot alter delivery
- Runtime metrics: every successful worker composition records one unlabeled
  process-start counter, so restarts are countable; artifact gauges aggregate
  real tenant-scoped PostgreSQL rows for all lifecycle statuses through forced
  RLS after successful `expire-artifacts` publication, with bounded
  failure-isolated runtime wiring and Postgres/S3/Redis composition evidence
- Audit: a duplicate inbox message with a different checksum never enters
  business work, commits a separate tenant-scoped security fact, and then fails
  closed; cross-workspace reads remain hidden by forced RLS
- Verification: `pnpm check`; `pnpm install --frozen-lockfile`;
  `pnpm test:integration`; `pnpm --filter @pertexo/worker test:resilience`;
  158 unit assertions, 69 PostgreSQL integration assertions, two object-store
  integration assertions, five worker composition assertions, and one
  destructive service-loss proof
- Failure injection: Redis DB 15 was erased after enqueue-before-mark and the
  durable outbox recovered in 1,123.26 ms; Redis outage was detected in 511.70
  ms and recovered in 5,714.29 ms with AOF retaining an existing job;
  PostgreSQL outage was detected in 1.14 ms and recovered in 5,708.74 ms;
  dispatcher drain closed in 0.89 ms, forced active-consumer drain in 55.32 ms,
  and no new row was claimed after readiness fell
- Cleanup/review: the resilience fixture restores PostgreSQL/Redis in `finally`,
  leaves isolated Redis DB 15 empty, and re-verifies `PONG` plus `pg_isready`;
  focused artifact, queue, metrics, database, runtime, and resilience reviews
  resolved all blocker/high findings before completion

## Phase 0E — Execution durability proofs and engine gate

Status: **Not started**

- [ ] Prove coordinator and node-attempt crash recovery.
- [ ] Prove checkpoint reconstruction from PostgreSQL-authoritative state.
- [ ] Prove waits survive worker and Redis restarts without occupying workers.
- [ ] Prove durable cancellation behavior.
- [ ] Prove deterministic branch, join, and bounded-loop recovery.
- [ ] Prove SSE reconstruction after Redis loss.
- [ ] Prove restricted JSONata evaluation limits and determinism.
- [ ] Record executable fixtures, automated failure tests, and measured results.
- [ ] Pass the custom-engine go/no-go gate or complete the required Temporal
      evaluation.

## Later phases

Use the delivery plan and vertical-slice completion rule as the checklist for
Phases 1–7. Expand the relevant phase here before implementation begins; do not
mark a phase complete from a high-level summary alone.

## Update protocol

When a checkpoint changes status:

1. Update its checklist and the summary table in the same logical change.
2. Record concrete evidence: ADRs, commits, commands, tests, measured results,
   or recovery exercises.
3. Leave incomplete or deferred requirements unchecked and explain blockers.
4. Never mark complete based only on generated files, passing unit tests, or a
   prose-only architecture proof.
5. Commit the tracker update with the implementation checkpoint or as its
   immediately following documentation commit.
