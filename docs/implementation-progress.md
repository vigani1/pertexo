# Backend Implementation Progress

Last updated: 2026-09-05

This file tracks delivery against
[the authoritative backend plan](./workflow-platform-backend-plan.md). A phase
is marked complete only when all of its plan requirements and applicable
vertical-slice completion criteria have passed. Commits or scaffolding alone do
not complete a phase.

Current audit note: the whole-repository review at implementation tree
`d1b41b6e9b6122de9914298e486c4b4635742f28` is recorded in
[the engineering audit](./whole-repository-audit.md). It does not change the
completed status of Phases 0–6. It confirms that Phase 7 remains **In progress**
because live AWS, provider, provenance, load, pager, backup, failover, and
regional-recovery evidence requires external accounts and deployed
infrastructure. Repository-controlled correctness, security, and runtime
findings are complete at the named implementation tree. Whole-audit A-11 and
code-audit C-21, C-22, C-26, and C-28 are complete; the remaining complexity,
coverage, immutability, and tooling entries are controlled, continuous,
evidence-gated, or conditional rather than unperformed repository defects.
Green repository checks are not represented as a substitute for live
production evidence.

Package-audit remediation is in progress. The rate-limit audit now has seven
repository-controlled findings fixed (RL-001 and RL-003 through RL-008), backed
by 29 package tests and enforced coverage of 95.04% statements, 91.42% branches,
92.3% functions, and 95.69% lines. RL-002 remains correctly classified as an
external evidence obligation: production must use and demonstrate a
non-clustered replicated Redis primary compatible with the atomic multi-key Lua
policy. Local mocks and repository fixtures are not treated as that evidence.

## Status summary

| Checkpoint | Status | Evidence |
| --- | --- | --- |
| Phase 0A — repository and process skeleton | Complete | ADR 001; commits `8d064cd`, `c80a70c`; `pnpm check`; compiled API and worker smoke checks |
| Phase 0B — PostgreSQL tenancy and RLS proof | Complete | ADR 003; commits `bad4b9e`, `9b4f6a4`, `a3bec51`, `6458fd4`; PostgreSQL 18.6 clean migration; 31 RLS integration tests |
| Phase 0C — HTTP and observability foundation | Complete | Commit `e8093d2`; 47 API/worker/observability tests; compiled role and OTLP trace/metric smoke checks |
| Phase 0D — queue, outbox, and duplicate-delivery proof | Complete | ADRs 005–006; migration head `0006_execution_vocabulary.sql`; 158 unit, 76 real integration, and one destructive recovery assertion |
| Phase 0E — execution durability proofs and engine gate | Complete | ADRs 005 and 007–009; commits through `0322837`; 239 unit, 96 real-service integration, five process-recovery, one SSE-outage, and one transport-outage assertions; custom-engine GO |
| Phase 1 — identity/workspace vertical slice | Complete | ADR 004; migration head `0011_workspace_creation_idempotency.sql`; 347 unit and 133 real-service assertions; generated contract drift gate; independent Spec and Standards completion GO |
| Phase 2 — workflow authoring vertical slice | Complete | ADRs 002/011; migration head `0012_workflow_authoring.sql`; 414 unit and 150 real-service assertions; generated contract drift gate; independent Spec and Standards completion GO |
| Phase 3 — first executable-node slice | Complete | ADR 010; implementation through `7487ae6`; migration head `0019_node_compatibility_preactivation.sql`; 575 unit and 217 sequential real-service assertions; five process-recovery, one transport-outage, one SSE-outage, and one additive-rollout assertion; independent Spec and Standards completion GO |
| Phase 4 — first side-effecting integration slice | Complete | ADRs 007/016; implementation through `28ae56b`; migration head `0031_due_node_wakeups.sql`; 248-database-assertion clean CI matrix plus real PostgreSQL/outbox/BullMQ retry-wakeup proof; CI recovery/service-loss matrix; independent fixed-head Spec and Standards completion GO |
| Phase 5 — orchestration slice | Complete | ADRs 008/017/018/019/020/021/022; implementation through `9d7e071`; migration head `0034_run_failure_notifications.sql`; 862 unit assertions and complete real-service/recovery matrix; independent fixed-head Spec and Standards completion GO |
| Phase 6 — V1 providers and triggers | Complete | ADRs 012–014 and 023–026; implementation through `0f8a170`; migration head `0043_workflow_run_input_retention.sql`; 1,021 unit and 288 real-service assertions; complete retained recovery and additive-rollout gates; independent fixed-head Spec and Standards completion GO |
| Phase 7 — production operations | In progress | ADRs 013/015/027/028/029/030 plus the ADR 004 browser-binding and ADR 016 deadline/identity amendments; migration head `0074_retention_schedule_state_rls.sql`; 24-hour terminal request-idempotency expiry with legal-hold-aware bounded reaping and 30-day expired/revoked session metadata grace with lock-safe bounded reaping; Frankfurt launch and Ireland recovery policy accepted; fail-closed cross-region replica-lag admission; full fail-closed startup compatibility separated from bounded recurring readiness; independently supervised retention/maintenance classes with bounded backoff; maintenance, readiness-gated lifecycle-command, and function-only operator credential boundaries, synchronous checksum-validated dual-region tenant-artifact writes and coordinated regional deletion, bounded PostgreSQL-authoritative committed-artifact restore inventory plus fail-closed regional byte verification before serve, automatic durable dual-ledger/hold-gated 30/90/365-day PostgreSQL and object-store retention plus frozen standard-class dry-run inventory, separate immutable five-minute preview execution and seven-day retention deadlines, the complete repository-owned operator command family, forward-only convergence of the published `0037`/`0038` migration variants, fenced and crash-repairable workspace tenant-row/object-version purge plus minimized completion tombstones, route-template-only API availability/latency SLIs including persisted-to-visible SSE latency, complete repository-owned PostgreSQL/Redis/object-store/process telemetry, non-root read-only ECS container/task contracts with separate roles and release-job migrations, digest-pinned deterministic render validation, declarative separate API/worker autoscaling inputs, production dependency and image scanning plus manual/scheduled local release gates, a bounded secret-free load-evidence harness, expanded emitted-series dashboards and alerts, all-six-command recovery projection plus legal-hold command coordination, durable operation-bound and lease-fenced lifecycle intents, atomic persisted-surface deletion side effects, asynchronous `202 Accepted` lifecycle API operations and direct-mutation revocation, bounded dual-region lifecycle coordinator and standalone command workers, fail-closed dual-region control-ledger facade, bounded restore-before-serve executable, a two-process MinIO integration harness, distributed abuse limits, truthful partitioned CI, immutable service-image validation, critical-module coverage, and a strict external AWS platform evidence contract; MinIO policy incompatibility blocks the full local control proof, while production operator IAM/admission and immutable-invocation evidence, live version-enabled tenant-bucket proof, AWS Object Lock/regional proof, measured deployed load/failure exercises, restore drills, deployed telemetry/pager proof, and deployed autoscaling evidence remain open; API-key and connected-subscription entities are explicitly deferred by the V1 plan and are not invented solely for deletion |

The `0A`–`0E` checkpoints are implementation-sized subdivisions of the plan's
single Phase 0. They do not alter the authoritative scope. Phase 0 is complete
because every required foundation, executable spike, measured result, and
custom-engine go/no-go condition has passed.

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

Status: **Complete**

- [x] Prove coordinator and node-attempt crash recovery.
- [x] Prove checkpoint reconstruction from PostgreSQL-authoritative state.
- [x] Prove waits survive worker and Redis restarts without occupying workers,
      including duplicate resume delivery.
- [x] Prove durable cancellation behavior, including cooperative abort of active
      work and truthful completed effects.
- [x] Prove deterministic branch, join, and bounded-loop recovery across
      coordinator crashes on both sides of checkpoint commit.
- [x] Prove SSE reconstruction after Redis loss.
- [x] Prove restricted JSONata evaluation limits and determinism.
- [x] Record executable fixtures, automated failure tests, and measured results.
- [x] Pass the custom-engine go/no-go gate or complete the required Temporal
      evaluation.

Current evidence:

- ADRs 007, 008, and 009 are accepted before their implementation decisions;
  commit `5b4dadc` records the state/retry/idempotency, bounded-loop, and
  restricted-JSONata contracts.
- Commits `7ef4b3e`, `064cd64`, and `7d7c3b9` add the pure checkpoint engine and
  bounded workflow model. The model's 24-test suite covers the exact V1 graph
  boundary, nested aggregate limits, deterministic canonical bytes and
  invocation keys, the restricted AST/capability surface, all exact/one-over
  input/output/depth/expression limits, hard worker-thread timeout and
  replacement, active/queued cancellation, shutdown, and repeated/two-worker/
  fresh-worker determinism. The engine's recovery semantics are accepted after
  the executable process-kill fixture and follow-up review described below.
- Commit `e4c80b2` adds migration `0007_execution_runtime.sql` and the durable
  execution repository: checkpoint CAS, gapless events, run/node/attempt state,
  leases and fence tokens, durable waits/retries/cancellation/deadlines, and
  unsafe-attempt reconciliation. A zero-state PostgreSQL 18.6 migration applied
  revisions `0000` through `0007`; 10 database unit tests and 88 real PostgreSQL
  integration assertions passed.
- Commits `92119cd`, `bdd7180`, `ec7a985`, and `5751cfc` add bounded
  subscribe-before-read SSE
  reconstruction, opaque Redis wake-up channels, a bounded publisher, and a
  production PostgreSQL/RLS reader. The API has 38 unit assertions and one real
  PostgreSQL+Redis composition assertion: notifications published before the
  subscriber were lost, reconnect from sequence 1 backfilled sequences 2–3 in
  bounded pages from PostgreSQL, then sequence 4 arrived live. The destructive
  fixture stopped Redis, detected publication failure in 1.09 ms, restored
  Redis health in 5,797.18 ms, and reconstructed the gap from PostgreSQL in
  5,810.51 ms. Aborting an SSE read now destroys an in-flight PostgreSQL client;
  the real `pg_sleep(30)` regression aborts in under two seconds and the next
  checkout receives clean workspace context.
- Commit `72b249c` resolves the independent engine review: cancellation cannot
  admit ready work, terminal/wait aggregation is truthful, exact duplicate
  outcomes are idempotent, malformed joins/loops/checkpoints fail closed,
  provider keys are bounded versioned digests, and integrated coordinator
  observations own deterministic join settlement and loop admission across a
  JSON checkpoint round trip. The engine suite passes 41 assertions.
- Commits `97f1a70` and `8ee526b` fix two defects found by the real composition
  proof: initial and resumed node-attempt outbox payloads now contain the exact
  run/node/attempt identifiers required by the strict queue contract. Both
  paths remain covered in the 88/88 real PostgreSQL integration matrix.
- Commits `2a28211`, `fff4146`, `fc69686`, `0136e45`, `ac797c0`, and `0322837`
  harden the dedicated real PostgreSQL+Redis/BullMQ execution and resilience
  gates. Five process assertions SIGKILL coordinator children after initial
  computation and on both sides of a recovered branch/join/loop checkpoint CAS,
  then reconstruct the exact ready set and outputs from a forced-RLS immutable
  workflow version plus checkpoint in fresh processes. A pure recovered
  checkpoint advances revision without inventing a domain event, and redelivery
  is fenced. Attempt children are killed before dispatch and after
  idempotent/unsafe dispatch; fencing produces one provider effect and truthful
  `outcome_unknown`. Reconciliation rejects live leases and emits the complete
  strict queue identity after expiry.
- The durable-wait proof releases its worker lease and BullMQ active slot,
  rejects early resume, restarts Redis in 5,976.94 ms, reaches the due/resume
  boundary in 7,102.69 ms, and completes in a fresh child in 726.57 ms.
  Concurrent due coordinators plus duplicate production BullMQ publication
  create and complete exactly one resumed attempt. Active cooperative work
  observes durable PostgreSQL cancellation through an `AbortSignal` while Redis
  is unavailable; recovery takes 12,241.58 ms, completed-effect count remains
  one, and fresh workers cannot claim or admit canceled work. A separate
  cancellation restart takes 5,975.06 ms. The resumed worker activates and
  exports an OpenTelemetry consumer span with the recovered W3C parent. Cleanup
  restores authenticated `PONG`, leaves Redis DB 15 empty, and verifies
  PostgreSQL health.
- Commit `dbe3659` records the restricted JSONata gate output: 101 evaluations
  across two workers and a pool restart completed in 836.15 ms with canonical
  SHA-256 `43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777`,
  evaluator `jsonata` 2.2.2, and policy version 1.
- Final verification is green for `pnpm install --frozen-lockfile`,
  `pnpm check` (239 unit assertions), the normal real-service matrix (88
  database, two object-store, one API SSE, and five worker assertions), five
  destructive Phase 0E process assertions, one destructive SSE assertion, and
  one transport outage/drain assertion.
- The Phase 0E command set is `pnpm install --frozen-lockfile`, `pnpm check`,
  `ARTIFACT_STORE_INTEGRATION=true WORKER_TRANSPORT_INTEGRATION=true
  API_SSE_INTEGRATION=true pnpm test:integration`,
  `PHASE0E_EXECUTION_INTEGRATION=true pnpm --filter @pertexo/worker
  test:phase0e`, `API_SSE_RESILIENCE_INTEGRATION=true pnpm --filter
  @pertexo/api test:sse-resilience`, and `WORKER_TRANSPORT_RESILIENCE=true pnpm
  --filter @pertexo/worker test:resilience`. The final process fixture passes
  five assertions in 41.16 seconds; the destructive SSE and transport fixtures
  pass one assertion each.
- ADR 005 records the measured evidence and the explicit **custom-engine GO**
  decision after the independent implementation review made this final
  ADR/progress record its sole remaining condition. The Temporal fallback is
  therefore not required at this gate.

## Phase 1 — Identity/workspace vertical slice

Status: **Complete**

- [x] Accept the managed OIDC and internal authorization decision before
      implementation.
- [x] Add reviewed migrations for platform users, identities, sessions, and
      workspaces plus forced-RLS memberships and append-only audit events.
- [x] Prove least-privilege runtime grants, absent-context failure, cross-tenant
      isolation, pool cleanup, and audit immutability with real PostgreSQL roles.
- [x] Implement one managed OIDC authorization-code flow with single-use state,
      nonce, PKCE, callback verification, and a narrow provider-neutral port.
- [x] Issue digest-only opaque sessions with bounded expiry/revocation, secure
      cookie policy, rotation seams, and CSRF protection for browser mutations.
- [x] Build immutable actor/request context and named capability authorization
      that proves membership before opening a workspace RLS transaction.
- [x] Atomically create a workspace, owner membership, and request/trace-linked
      audit event through the authorized API slice.
- [x] Implement workspace deletion request and restore foundations with local
      session revocation, access/run/trigger prevention seams, and restore to
      `suspended` without silently re-enabling access.
- [x] Prove the complete login-to-authorized-command flow with unit/application
      tests and real PostgreSQL plus a fake OIDC provider, including replay,
      tamper, expiry, revocation, CSRF, role/capability, rollback, conflict, and
      sanitized RFC 9457 error cases.
- [x] Record API contracts, fixed-cardinality auth/workspace telemetry, command
      matrix, assertion counts, migration evidence, and independent
      blocker/high review before completion.

Current evidence:

- ADR 004 (`a59cce2`) accepts managed OIDC, opaque local sessions, explicit
  workspace selection, role-to-capability policy, PostgreSQL-first audit, and
  durable deletion/restore boundaries. It explicitly defers invitations,
  custom passwords, enterprise claim/group sync, multi-provider abstraction,
  service accounts, and API keys from this slice.
- ADR 003 remains authoritative for direct `workspace_id`, forced RLS,
  least-privilege runtime roles, and `SET LOCAL` transaction scope.
- Phase 0E completed the custom-engine gate in `b9c923d`; Phase 1 has no
  remaining execution-foundation prerequisite.
- Commits `76f5924` and `c5f8112` add the immutable actor context, canonical workspace roles
  and named capabilities, fail-closed membership/workspace authorization, and
  bounded credential-redacting audit facts. Actor, workspace, and session
  identities now fail closed unless they are UUID-compatible with persistence.
  The focused Vitest suite passes 20
  adversarial assertions; scoped ESLint, Prettier, and staged diff checks pass.
- Commit `7e336ca` adds the provider-neutral OIDC authorization-code service,
  single-use digest-keyed state/nonce/PKCE contracts, bounded verified profile
  mapping, UUID-backed digest-only opaque sessions, secure cookie/rotation
  policy, and double-submit CSRF defense. Its focused Vitest suite passes 19
  adversarial assertions; the complete API suite passes 77 assertions and API
  typecheck, build, ESLint, Prettier, and diff checks pass.
- Commit `88b42da` adds migration head `0009_oidc_login_transactions.sql`,
  atomic issuer/subject identity resolution, digest-only sessions, sealed
  single-use OIDC transactions, forced-RLS memberships, append-only audit,
  workspace creation/access/deletion/restore repositories, and narrow worker
  lifecycle visibility. Clean zero-to-head and previous-head (`0007`) upgrade
  runs both pass the full 100-assertion real-PostgreSQL suite; 13 assertions
  belong to the new Phase 1 repository slice. Database unit tests (10),
  typecheck, build, ESLint, Prettier, and diff checks pass.
- Commit `6bb356e` adds one-statement digest revocation with a concurrent
  one-winner/idempotency regression, raising the focused Phase 1 repository
  suite to 14 assertions and the full database integration matrix to 101.
- Commit `7ed8517` adds the thin Nest identity/workspace application boundary:
  strict contracts, OIDC callback/session and aligned CSRF cookies, logout,
  immutable session authentication, pre-transaction workspace capability
  checks, create/delete/restore use cases, database adapters, and stable safe
  error mapping. Its focused suite passes 15 assertions across five files;
  scoped ESLint, Prettier, and diff checks pass. Root runtime registration and
  the real-PostgreSQL/fake-provider API proof remain pending, so no additional
  completion box is checked yet.
- Commit `3d1a731` exposes only the middleware-validated request identifier to
  downstream guards/controllers, keeping audit request IDs aligned with the
  RFC problem response instead of re-reading an untrusted header.
- Commit `9ed528a` adds the provider infrastructure boundary: stateless generic
  OIDC discovery endpoints with bounded authorization/token/JWKS I/O, strict
  signature/issuer/audience/algorithm/nonce claim validation, and AES-256-GCM
  sealing of durable PKCE/nonce material with associated data and key rotation.
  Fourteen focused infrastructure assertions and the complete 106-assertion
  API suite pass, together with API typecheck, production build, scoped ESLint,
  Prettier, and diff checks. Production configuration/runtime registration and
  the real-PostgreSQL fake-provider proof remain pending.
- Commit `e47097c` completes the public identity/workspace API boundary with a
  stable `workspace.conflict` 409 problem, explicit owner-only deletion and
  recovery source states, fixed-cardinality operation telemetry, and OpenAPI
  3.1 plus browser client schemas projected from the owning Zod contracts.
  The complete API suite passes 126 assertions; 13 focused real-PostgreSQL
  lifecycle assertions and scoped typecheck/build/lint/format checks pass.
- Commit `7be65b2` composes the generic OIDC provider, AES-GCM keyring, identity
  database, durable OIDC transaction store, persistence adapter, and Nest
  feature module from validated production configuration. Shutdown owns both
  pools, staging/production fail closed without secure identity settings, and
  the injected runtime seam remains available for real-stack tests. Production
  metrics/traces use the global OpenTelemetry provider and telemetry failures
  cannot change command truth; 23 focused bootstrap/config/runtime assertions
  pass with API typecheck, build, ESLint, Prettier, and diff checks.
- Commit `e09f5a5` takes a PostgreSQL workspace lifecycle lock before atomic run
  acceptance. Missing, suspended, pending-deletion, and deleted workspaces fail
  closed, while admission-versus-deletion races serialize in either truthful
  order. The focused real-PostgreSQL acceptance/runtime suites pass 31
  assertions with database typecheck, build, ESLint, and Prettier checks.
- Security review fixes are committed in `b17e250`, `4a82030`, `2ac0134`,
  `10791af`, `1f8abf8`, and `ea91dbd`: mandatory bounded OIDC token lifetime,
  inactive-user denial, durable accepted-run idempotency after deletion,
  reachable 409 lifecycle conflicts, stable 503 provider availability,
  bounded durable OIDC transaction storage, and authenticated ALS
  actor/workspace correlation. Migration head `0010_oidc_transaction_capacity.sql`
  passes clean zero-to-head and `0009`-to-`0010`; the full real-PostgreSQL
  database matrix passes 117 assertions.
- Commit `af9f1f0` adds the CI-gated real PostgreSQL plus Nest HTTP and fake OIDC
  proof. Five consolidated scenarios pass in 5.75 seconds and cover durable
  state/nonce/PKCE, replay/tamper, secure opaque cookies, CSRF, atomic
  workspace/owner/audit creation, forged access, deletion/session revocation,
  pre-purge restore, conflicts, expiry, logout, rollback evidence, and
  sanitized RFC 9457 failures. API typecheck, build, ESLint, Prettier, and diff
  checks pass. Final repository-wide integration/regression and independent
  re-review remain before the phase can be marked complete.
- Commit `9c01492` enforces the PostgreSQL-authoritative pre-purge restore
  deadline; an expired restore remains pending deletion, adds no audit fact,
  and maps to `workspace.conflict`.
- Commit `80e1c4c` requires bounded visible-ASCII `Idempotency-Key` headers for
  workspace creation, deletion, and restore. Creation claims are actor-scoped
  under forced RLS; lifecycle claims reuse tenant-scoped forced-RLS records.
  Claims, aggregate changes, audit, session revocation, and durable results
  commit atomically. Exact concurrent/re-authenticated retries return the same
  result with one audit/revocation, while changed requests return
  `request.idempotency_conflict`; revoked sessions remain unauthorized.
  Migration head `0011_workspace_creation_idempotency.sql` is applied.
- Commit `76939ce` adds the browser-safe `@pertexo/contracts` package as the
  owner of the Phase 1 HTTP Zod schemas and public RFC 9457 problem taxonomy.
  The API consumes those shared contracts, every route documents reusable
  `application/problem+json` responses, and deterministic OpenAPI 3.1 plus
  client-schema JSON artifacts are committed. `pnpm contracts:check`
  byte-compares regenerated output, and the root `pnpm check` gate runs that
  drift check before typechecking and tests.
- Final gates: `pnpm check` passes formatting, lint, generated-contract drift,
  typechecks, 347 unit assertions, and all production builds. The full
  real-service command (`ARTIFACT_STORE_INTEGRATION=true
  WORKER_TRANSPORT_INTEGRATION=true API_SSE_INTEGRATION=true
  API_IDENTITY_INTEGRATION=true pnpm test:integration`)
  passes 133 assertions: 120 PostgreSQL, two object-store, five worker, and six
  API. Migration head is `0011_workspace_creation_idempotency.sql`.
- Independent Spec review found no remaining blocker/high after the restore
  deadline and durable idempotency fixes. Independent Standards re-review at
  `76939ce` independently passed contract drift, typecheck, four contract
  tests, build, and diff checks and returned a clean Phase 1 completion GO with
  no new blocker/high finding.

## Phase 2 — Workflow authoring vertical slice

Status: **Complete**

The required ADRs and the workflow-authoring thin slice have been implemented
through persistence, HTTP/runtime composition, generated public contracts, and
real-service verification. The final repository-wide gates and independent
Spec/Standards reviews passed with no remaining blocker/high findings.

Plan-aligned checklist:

- [x] Accept ADR 002 for PostgreSQL JSONB drafts, immutable versions,
      versioned executable-projection checksum identity, and identical-content
      version reuse before workflow persistence is implemented.
- [x] Accept ADR 011 for whole-graph optimistic draft concurrency,
      strong ETag semantics, HTTP preconditions, conflict responses, and the
      future collaboration boundary before the draft save API is implemented.
- [x] Define the workflow-authoring domain vocabulary and canonical constants,
      including lifecycle/activation states, draft revision rules, graph schema
      versioning, and immutable version identity.
- [x] Own the canonical graph, authoring request/response, validation-report,
      and published-version Zod contracts in the appropriate shared packages;
      parse them at every HTTP and persistence seam.
- [x] Add reviewed PostgreSQL migrations only for `workflows`,
      `workflow_drafts`, and `workflow_versions`, reusing the existing audit and
      outbox foundations. Enforce tenant scope, forced RLS, least-privilege
      runtime grants, indexes, same-workflow published-pointer integrity,
      exactly one live mutable draft per workflow, immutable version rows, and
      unique version/checksum constraints.
- [x] Create a workflow and its one empty JSONB draft atomically, with an
      idempotent retry contract and an audit fact; the draft cannot be omitted,
      duplicated, deleted, or replaced independently of its workflow.
- [x] List workspace workflows with deterministic cursor pagination and load
      one authorized draft with its revision, strong ETag, and
      definition-compatibility report without exposing cross-workspace
      existence. The strong validator covers the complete returned
      representation, including the compatibility fingerprint; a registry
      rollout may therefore require a safe refetch instead of treating two
      different reports as equivalent.
- [x] Save one coherent, structurally valid, within-limit graph snapshot only
      when a required strong `If-Match` value matches; return HTTP `428` when
      the precondition is absent and HTTP `412` with
      `workflow.revision_conflict` when it is stale or does not match. Increment
      the revision on success and never overwrite concurrent work.
- [x] Validate the current draft read-only using the same graph limits and
      pinned-definition compatibility rules used by publication, returning a
      stable typed validation report without mutating the draft.
- [x] Define a versioned canonical executable projection for checksum identity.
      It includes execution-relevant graph/schema/definition/settings content
      but excludes presentation-only metadata such as node position and label;
      focused fixtures must prove both included and excluded fields.
- [x] Publish in one transaction: require the same strong `If-Match` contract
      plus an `Idempotency-Key`, lock and freeze that coherent draft revision,
      run deterministic validation, calculate the versioned
      executable-projection checksum, create or reuse one immutable version,
      update the same workflow's published pointer while keeping activation
      inactive, append the audit fact, and write one versioned
      `workflow.published` outbox record at the existing typed
      `reconcile-workflow-triggers` dispatch boundary.
- [x] Give publish commands durable idempotency semantics: an exact retry with
      the same key, original `If-Match`, and request hash returns the stored
      result before current-state comparison and without another audit fact or
      outbox record; reusing the key for a changed request returns
      `request.idempotency_conflict`; a distinct key with a stale validator
      returns `workflow.revision_conflict` `412`, while a distinct key with the
      same current executable content is a new publish attempt that reuses the
      existing version and records its own audit/outbox effects.
- [x] Add a validated dispatcher job-kind allowlist. Phase 2 excludes
      `reconcile-workflow-triggers`, keeping those outbox rows durable,
      unpublished, unleased, and unattempted in PostgreSQL and absent from
      Redis until Phase 6 deploys a ready consumer before enabling that kind.
- [x] Return the existing immutable version when identical executable content
      is published again; never clone content merely to increment a version
      number, and keep published snapshots unchanged when the draft later
      changes.
- [x] Prove save-versus-publish races cannot produce a mixed snapshot: publish
      freezes exactly one draft revision, the immutable version matches that
      complete revision, and a concurrent successful save affects only the live
      draft and never the frozen published version.
- [x] Expose and document only the Phase 2 endpoints: list/create workflows,
      get/save draft, validate, publish, and list immutable versions. Controllers
      remain limited to contract parsing, authenticated actor/workspace context,
      one use-case call, and response mapping.
- [x] Enforce named workflow read/update/publish capabilities plus active
      workspace membership at the application boundary and PostgreSQL tenant
      isolation through the real Phase 0/1 runtime roles.
- [x] Map malformed input, hidden resources, authorization failures, revision
      conflicts (`428`/`412`), invalid workflows, idempotency conflicts, and
      unexpected failures through the shared RFC 9457 catalog with bounded safe
      logs.
- [x] Add fixed-cardinality traces/metrics and the relevant audit/outbox effects
      without workflow, workspace, actor, or version IDs in metric labels.
- [x] Publish browser-safe shared client contracts and deterministic generated
      API/client artifacts, and make contract drift a required verification
      gate before the canvas consumes the API.
- [x] Prove the use-case transaction boundaries, rollback behavior, exact and
      conflicting retries, strong-ETag preconditions, concurrent draft saves,
      save-versus-publish races, concurrent/duplicate publishes, exactly one
      live draft, immutable frozen history, executable-projection checksum
      inclusion/exclusion, authorization, cross-workspace isolation, RLS/grants,
      and safe problem responses with unit plus real PostgreSQL/HTTP integration
      tests.
- [x] Run the repository-wide quality gate and the full applicable real-service
      integration suite, record exact assertion counts and migration head, and
      resolve every blocker/high finding from independent Spec and Standards
      completion reviews.
- [x] Keep canvas integration deferred until every API, authorization,
      conflict, publish, contract, and verification item above passes; no
      canvas work is used as backend Phase 2 completion evidence.

Thin-slice exclusions:

- Executable node definitions, run/event/checkpoint persistence, coordinator or
  node-attempt jobs, SSE run reconstruction, cancellation, worker reads of
  immutable workflow versions, and unsupported-version execution proofs remain
  Phase 3. The Phase 2 worker role receives no workflow-version read grant.
- Connections, credentials, generic HTTP execution, node preview/test execution,
  bounded artifact behavior, `workflow_integration_usage` persistence, and its
  projection proof remain Phase 4.
- Condition/Switch, loops, parallel/merge, Wait, providers, webhook/Schedule
  triggers, desired-trigger persistence, external trigger reconciliation and
  activation proof, and production operations remain Phases 5–7. Phase 2 emits
  only the typed reconciliation boundary, holds it behind the dispatcher
  allowlist, and leaves workflows inactive.
- Folders, tags, templates, workflow dependencies, sub-workflows, multiplayer
  merging, and gesture-by-gesture database records remain explicitly deferred.

Verification and evidence gates:

- ADR 002 and ADR 011 must remain authoritative for their affected code.
- Migrations must pass clean zero-to-head and supported prior-head upgrades;
  schema compatibility, forced RLS, grants, constraints, and immutability must
  be exercised under the actual API and migration roles.
- The real dispatcher and worker composition must prove the held reconciliation
  kind is not claimed or enqueued while other enabled kinds still dispatch.
- Focused checks may support individual checkpoints, but phase completion
  requires the repository-wide quality gate, generated-contract drift check,
  full applicable real-service suite, and independent Spec/Standards review.
- Evidence must name the accepted ADRs, coherent commits, migration head,
  exact commands and assertion counts, transaction/failure exercises, and
  review outcomes. Generated files, unit tests, or prose alone are insufficient.

Logical checkpoint intent:

- Record the accepted persistence and concurrency decisions as one reviewable
  documentation checkpoint before implementation.
- Land the canonical model/contracts and deterministic checksum behavior as a
  coherent checkpoint with focused tests.
- Land the tenant-scoped schema plus persistence adapters and real PostgreSQL
  proofs as one or more independently reviewable, working checkpoints.
- Land each complete API/use-case behavior with its authorization, errors,
  telemetry, audit/outbox effects, client contract, and relevant tests rather
  than committing controller or table scaffolding by itself.
- Record final integration evidence and mark Phase 2 complete only after all
  checklist items and completion reviews pass. The number of commits follows
  coherent reviewable purposes; it is not predetermined.

Initial evidence:

- Phase 0's custom-engine gate and Phase 1's authenticated actor/workspace,
  authorization, forced-RLS, audit, problem-details, telemetry, idempotency,
  and shared-contract foundations are complete and available to this slice.
- ADR 002 and ADR 011 are accepted before implementation. They define the
  executable-content identity, immutable publication, publish idempotency,
  held reconciliation-outbox boundary, strong `If-Match`/ETag behavior, and
  future collaboration boundary.
- Commit `eb3b286` adds the bounded V1 graph contract, separate draft and
  publication parsers, definition compatibility, deterministic executable
  projection, and versioned SHA-256 identity. Its 44-test suite covers exact
  and one-over graph/depth/resource limits, cycle/dangling/unknown-definition
  rejection, presentation-field identity exclusions, execution-field identity
  inclusion, and retained-version checksum verification without requiring an
  historical definition to remain active.
- Commit `1a182fd` adds migration `0012_workflow_authoring.sql`, Drizzle schema,
  tenant-scoped authoring repository, and fail-closed readiness. A clean
  PostgreSQL 18 database applied through head `0012`; 17 database unit tests and
  133 real PostgreSQL integration assertions passed. The proof covers atomic
  workflow plus revision-1 draft creation, durable create/publish idempotency,
  cursor pagination, CAS saves, both save/publish lock orders, rollback at every
  publication step, checksum/version reuse, immutable history, RLS/grants,
  readiness drift, exact graph-size limits, and corrupt retained-checksum
  rejection before pointer, audit, or outbox mutation.
- Commit `0e989a7` adds the deployment capability gate for outbox dispatch. The
  Phase 2 default is an empty enabled-job set because production composes no
  queue consumers yet; any configured kind must be in the build allowlist and
  have a composed ready consumer before a row can be claimed. The real
  PostgreSQL+Redis+BullMQ proof passes five assertions: enabled work publishes,
  `reconcile-workflow-triggers` remains unpublished, unleased, unattempted, and
  absent from Redis, and the job-leading partial index serves enabled claims
  despite a 2,000-row held backlog. Database and worker unit suites pass 17 and
  40 assertions respectively.
- Independent Spec and Standards reviews returned GO for the model and
  persistence checkpoint. The worker role cannot read workflow versions, every
  workflow stays inactive, and reconciliation outbox rows remain held pending
  the separate dispatch-capability checkpoint and the Phase 6 consumer.
- Commit `91c6b6e` adds the browser-safe workflow-authoring contracts, one
  guarded graph-schema source shared with the server model, deterministic
  OpenAPI/client artifacts, the complete-representation strong ETag codec, and
  typed RFC 9457 `428`/`412` handling. Contracts pass 7 tests and drift
  verification; workflow-model passes 45 tests; the focused problem filter
  passes 9 tests.
- Commit `537162d` deepens the persistence seam with atomic create read models,
  compatibility-aware drafts, deterministic workflow/version pages,
  archived-save denial, conflict ETags, and exact publish replay before
  current-state comparison. Database unit tests pass 17 assertions and the
  focused real PostgreSQL authoring suite passes 14 assertions at migration
  head `0012_workflow_authoring.sql`.
- Commit `16bc14a` adds the application use cases, strict precondition parsing,
  bounded telemetry, authorization, error mapping, and thin controllers.
  Commit `5a9e8fa` composes them with the existing identity guards, canonical
  authorized workspace context, real workflow database lifecycle, OTel
  adapters, and Nest bootstrap/shutdown. The API suite passes 165 tests and the
  consolidated real PostgreSQL HTTP suite passes 6 scenarios, including
  session/CSRF authorization, RLS-hidden access, create/list/read/save/validate/
  publish/version listing, missing and stale preconditions, exact publication
  replay, and safe typed problem responses.
- Commit `63d4c42` restores canonical graph ownership to the browser-safe
  `@pertexo/workflow-model/graph-contract` export, makes public contracts consume
  that owner in the plan-aligned direction, centralizes RFC 9457 problem-schema
  construction, and publishes required strong `ETag` response contracts.
  Commit `843a0e2` removes the pre-replay draft read, preserves same-transaction
  revision/ETag conflict pairs, emits the created draft ETag, and adds the
  request/trace and concurrency regressions required by the completion review.
- Final `pnpm check` passes formatting, lint, deterministic contract drift,
  every typecheck and production build, and 414 unit assertions: 28 artifact,
  32 observability, 35 queue, 41 engine, 45 workflow-model, seven contracts, 17
  database, 40 worker, and 169 API.
- Commit `80de849` makes the root real-service gate deterministic by running the
  four suites sequentially against shared local services. On a fresh isolated
  PostgreSQL 18 database migrated zero-to-head
  `0012_workflow_authoring.sql`, `pnpm test:integration` passes 150 assertions:
  two object-store, 135 database, six worker/PostgreSQL/Redis/BullMQ, and seven
  API/PostgreSQL/SSE. The temporary database was dropped afterward; PostgreSQL
  and Redis remained healthy.
- Independent Spec and Standards completion reviews at `0ca1edd` returned GO
  with no blocker/high findings after verifying publish replay ordering,
  same-snapshot conflict hints, canonical graph ownership, shared problem
  contracts, request/trace regression coverage, package boundaries, generated
  artifacts, tracker accuracy, and commit coherence. Targeted re-reviews at
  `80de849` also returned GO for the deterministic full-integration gate and its
  150-assertion evidence.

## Phase 3 — First executable-node slice

Status: **Complete**

Phase 3 has completed its design prerequisites, package foundations, durable
coordinator/attempt state, and readiness-gated execution consumers. The exact
Manual -> Set/Map -> Terminate graph now executes through PostgreSQL, Redis, and
BullMQ with duplicate attempt delivery. Authorized publication now compiles and
stores its exact V2 executable envelope, and the public Start/Get/Stream/Cancel
slice is live. The initial durable compatibility-release authority, exact
retained fixtures, active-work cancellation recovery, and the Phase 3
non-removal barrier and audited target preactivation/deployment approval are now
complete. The complete Phase 0/fleet matrix and independent completion reviews
are green at fixed implementation commit `7487ae6`.

Design prerequisites:

- [x] Expand this tracker with the exact Phase 3 scope, exclusions, coherent
      checkpoints, and completion evidence required by the authoritative plan.
- [x] Review and accept ADR 010 for node/executor compatibility, version
      resolution, migration, rolling readiness, and retirement before releasing
      the node registry.

Thin-slice scope and node contracts:

- [x] Implement exactly one executable graph: Manual Trigger -> Set/Map ->
      Terminate.
- [x] Use the exact definition identities `core.manual@1`, `core.set@1`, and
      `core.terminate@1` and the separately owned exact executor identities
      `core.manual@1`, `core.set@1`, and `core.terminate@1`; matching names do
      not merge definition and executor identity.
- [x] Add browser- and worker-safe versioned definition/config schemas for all
      three nodes, with bounded inputs and outputs and stable canonical node
      type/version constants.
- [x] Add the node SDK definition and executor contracts without NestJS, ORM,
      Redis, BullMQ, or provider dependencies.
- [x] Add the core-node registry and adapt its definition catalog to the
      workflow model without reversing canonical graph ownership.
- [x] Keep browser-safe manifests limited to metadata, schemas, lifecycle,
      compatibility, and exact executor references; prove package export maps
      make server executor implementations impossible to resolve in a browser
      build.
- [x] Resolve Set/Map inputs through the accepted restricted-JSONata policy and
      validate configuration and mapped output at every untrusted seam.
- [x] Prove pinned executor lookup, retained-version compatibility, supported
      config migration, and fail-closed missing/retired/incompatible executor
      behavior.
- [x] Keep every Phase 3 node absent from the publishable registry until its
      contracts, authorization, use case, adapters, telemetry, idempotency,
      cancellation, API/job documentation, and happy/failure-path tests pass.

Production execution and persistence:

- [x] Deepen the engine around the two production operations
      `AdvanceWorkflow` and `ExecuteNodeAttempt`, with the canonical published
      graph adapted into private scheduler state rather than a second public
      graph model.
- [x] Introduce the versioned Phase 3 published-executable envelope separately
      from the definition-only authoring graph. Pin each node's exact definition,
      config, executor, and applicable runtime-policy references in immutable
      published bytes.
- [x] Introduce executable projection/checksum version 2 for that envelope
      rather than silently changing `wf:v1`; retain, parse, and verify Phase 2
      `wf:v1` immutable versions under their original graph and checksum rules.
- [x] Replace unsafe checkpoint assertions at the production boundary with
      bounded schema validation or explicit safe parsing, and reject malformed
      or recursively bypassed graph/checkpoint data.
- [x] Persist run acceptance, the immutable workflow-version reference,
      request idempotency, gapless events, checkpoints, node runs, attempts,
      leases/fence tokens, cancellation, and transactional outbox effects under
      their documented transaction and compare-and-swap boundaries.
- [x] Add a reviewed migration granting the worker only the immutable published
      workflow-version read access required by execution; prove it cannot read
      drafts, mutate authoring data, cross workspaces, own tables, or bypass
      forced RLS.
- [x] Implement narrow behavior-named persistence ports such as
      `PublishedWorkflowReader` and `RunStore`; keep SQL, ORM rows, transaction
      assembly, and generic repositories out of engine and consumer seams.
- [x] Compose a thin coordinator consumer that loads PostgreSQL-authoritative
      state, advances one checkpoint revision, records ordered events, and
      emits continuation/node-attempt outbox work atomically.
- [x] Compose a separate thin node-attempt consumer that claims with a lease and
      fence token, executes outside long database transactions with an
      `AbortSignal`, records the truthful outcome, and emits continuation work.
- [x] Preserve IDs-only versioned queue payloads, at-least-once delivery,
      idempotent redelivery, readiness-gated dispatch, bounded draining, and
      PostgreSQL ownership of durable retries and cancellation.
- [x] Complete the exact Manual -> Set/Map -> Terminate graph after duplicate
      coordinator and attempt delivery without duplicating node effects,
      terminal events, or terminal state.

Compatibility rollout, readiness, and retirement:

- [x] Define and enforce separate definition and executor lifecycle transitions,
      including placement, publication, execution, retention, retirement, and
      historical read behavior without identity reuse or latest-version
      substitution.
- [x] Compute the deterministic full-release fingerprint over the complete
      compatibility catalog and a distinct selection fingerprint over only the
      definitions, executors, migrations, and runtime policies pinned by one V2
      envelope; use the correct fingerprint in authoring tags, durable release
      records, executable identity, and retained compatibility fixtures.
- [x] Prove additive-before-subtractive rolling releases: the complete worker
      cohort supports and reports an exact compatibility epoch/fingerprint
      before API publication or placement can create a reference, and mixed API
      replicas fail closed through the documented conservative ETag conflict.
- [x] Persist append-only audited compatibility-release records plus the
      current epoch/fingerprint in PostgreSQL. Require role-specific expected-
      pair validation, target-pair preactivation readiness, deployment approval,
      and same-transaction current-release locking for publication and new
      admission; deployment evidence supports but never replaces the durable
      authority.
- [x] Make readiness fail closed on duplicate identities, invalid bindings,
      unsupported graph/config/checksum/evaluator/job/event versions, migration
      or grant drift, and local registry/expected-fingerprint disagreement;
      keep cross-workspace dependency inspection out of serving-role readiness.
- [x] Enforce the Phase 3 non-removal invariant: all three executors remain in
      the active/retained release, no serving or maintenance path can move them
      to `retirement_blocked` or `retired`, and no subtractive worker artifact
      can omit them.
- [x] Prove retired historical versions remain readable but are described as
      executable or reproducible only while their exact executor and replay
      support window remain retained.

API, SSE, and cancellation:

- [x] Add generated Zod/OpenAPI/client contracts and stable RFC 9457 problems
      for starting, reading, streaming, and canceling this graph without
      exposing checkpoints, ORM rows, or internal engine objects.
- [x] Implement authorized `StartWorkflowRun`, `GetWorkflowRun`,
      `StreamRunEvents`, and `CancelWorkflowRun` use cases with thin NestJS
      controllers and canonical workspace/request/trace context.
- [x] Return `202 Accepted` only after the queued run, immutable version
      reference, initial event/checkpoint, idempotency record, and outbox row
      commit atomically; exact idempotency replays must return the original run.
- [x] Prove through the real HTTP/API and PostgreSQL path that reusing an
      idempotency key with a different canonical request hash fails with the
      stable conflict problem and creates no duplicate run, event, checkpoint,
      idempotency, or outbox row.
- [x] Reconstruct SSE from PostgreSQL-authoritative ordered events using bounded
      subscribe-before-read catch-up, opaque Redis wake-ups, reconnect cursors,
      and backfill after Redis loss.
- [x] Make cancellation durable and monotonic, prevent new admission after the
      cancel boundary, cooperatively abort active work, and report completed
      work and unknown outcomes truthfully.
- [x] Prove authorization, capability checks, hidden cross-workspace resources,
      CSRF for browser mutations, safe errors/logs, bounded telemetry, and
      audit/usage effects where applicable.

Required completion evidence:

- [x] Pass focused unit, typecheck, lint, format, build, and deterministic
      generated-contract, OpenAPI/client, migration-manifest, and other
      generated-artifact drift gates for every changed package and role.
- [x] Apply every reviewed SQL migration from the completed Phase 2 head
      `80de849` through the fixed Phase 3 head, as well as from a clean zero
      state, and prove the checked-in migration manifest, schema model,
      readiness introspection, grants, constraints, and immutable-version
      triggers agree.
- [x] Pass real PostgreSQL role/RLS/migration tests for run acceptance,
      idempotency, version loading, checkpoint CAS, events, attempts,
      cancellation, and least-privilege grants from a clean zero-to-head
      migration.
- [x] Retain at least one immutable graph/executable/checksum fixture for every
      supported definition/executor pair and every supported executable format,
      including Phase 2 `wf:v1`; prove each fixture selects only its exact
      executor or remains safely readable when it is intentionally
      non-executable.
- [x] Pass real PostgreSQL + Redis + BullMQ tests for the full thin graph,
      duplicate deliveries, enqueue-before-mark recovery, consumer readiness,
      drain behavior, and process restart boundaries.
- [x] Re-run every applicable Phase 0B tenancy failure: absent workspace
      context, cross-workspace reads/writes, commit/rollback and sequential/
      concurrent pool reuse, non-owner/non-`BYPASSRLS` runtime roles, forbidden
      grants, forced-RLS/policy drift, and incompatible migration readiness.
- [x] Re-run every applicable Phase 0C HTTP/observability failure: invalid or
      propagated request identity, safe RFC 9457 mapping, recursive secret/error
      redaction, trace/metric bootstrap and correlation, dependency readiness,
      bootstrap cleanup, graceful `SIGTERM` drain, and package/server-only export
      boundaries.
- [x] Re-run every applicable Phase 0D queue/outbox failure: transactional
      rollback, duplicate delivery and concurrent inbox fencing, checksum
      mismatch audit, enqueue-before-mark recovery, Redis and PostgreSQL outage/
      recovery, propagated queue trace context, timeout/abort/unrecoverable
      handling, readiness loss, bounded active drain, and no post-drain claims.
- [x] Re-run every Phase 0E execution failure fixture: coordinator crashes
      before and after checkpoint commit, node-attempt crashes before dispatch
      and after idempotent/unsafe dispatch, expired-attempt reconciliation,
      durable wait/retry recovery fixtures that remain applicable to the shared
      runtime, cancellation during active work and restart, and exact
      redelivery fencing.
- [x] Re-run the Phase 0E Redis-loss SSE reconstruction and worker transport
      outage/drain fixtures, proving PostgreSQL remains authoritative and no
      work is claimed after readiness falls.
- [x] Run the root `pnpm check` and the complete real-service integration
      matrix sequentially in dependency-safe order, then record commands,
      versions, assertion counts, timings, migration head, and cleanup/health
      evidence here.
- [x] Complete independent Spec and Standards reviews against the fixed Phase 3
      HEAD with no blocker/high findings, including package direction,
      generated artifacts, manifest/lockfile coherence, unsafe casts, node
      compatibility, and tracker accuracy.
- [x] Mark Phase 3 complete only after every box above is checked and concrete
      commits and verification evidence replace this prerequisite-only status.

Explicit exclusions for Phase 3:

- No provider calls, connections, secrets, generic HTTP Request, previews, or
  other side-effecting integration behavior; those begin in Phase 4.
- No Condition, Switch, Wait, For Each, Parallel, Merge, schedules, webhooks,
  polling, failure notifications, or arbitrary-cycle expansion.
- No durable delay ownership in BullMQ, queue payloads containing graphs or
  large values, generic repository layer, CQRS framework, microservice split,
  or controller-owned business transactions.
- Existing Phase 0 branch/join/loop proofs remain regression fixtures only;
  they do not make those nodes publishable in this slice.
- The ADR 010 retirement maintenance command, dependency query across later
  replay/trigger paths, retirement CAS finalization, and real subtractive fleet
  rollout remain deferred until the first executor retirement after the owning
  slices and Phase 7 operator controls exist. Phase 3 proves non-removal rather
  than scaffolding those future paths.

Planned coherent checkpoints:

1. Accept ADR 010 and record the final compatibility/retirement contract.
2. Add the functional node SDK, three core definitions/executors, registry
   adapter, and compatibility tests without empty package scaffolding.
3. Add the version-2 published-executable envelope/checksum, retained-v1
   validation, production engine seams, and safe canonical graph/checkpoint
   adapter with in-memory thin-graph verification.
4. Add the worker published-version grant migration and narrow execution
   persistence adapters with real PostgreSQL/RLS evidence.
5. Add the coordinator behavior and enable its dispatch capability only when
   the composed consumer is ready.
6. Add node-attempt execution and enable its dispatch capability only when the
   complete executor path is ready; combine checkpoints 5 and 6 if separating
   them would leave a broken or dispatchable half-state.
7. Add the authorized run API, PostgreSQL-authoritative SSE reconstruction, and
   durable cancellation vertical slice with generated contracts.
8. Re-run all quality, real-service, applicable Phase 0B–0E failure, retained-
   compatibility, generated-drift, and independent review gates, then record
   final evidence in this tracker.

Current evidence:

- ADR 010 is accepted after independent Spec and Standards reviews resolved the
  durable pinning, rollout/readiness, race-safe retirement-policy, continuation-
  drain, and Phase 3 scope findings.
- Commit `85385cc` adds the browser-safe compatibility-release and schema
  contracts plus a server-only exact registry. Follow-up fixes `2d5bfdc`,
  `16abe41`, and `0ec4009` align browser/server JSON admission, publish bounded
  schema documents, and reject oversized sparse arrays before allocation. The
  node SDK passes 18 focused assertions, typecheck, build, ESLint, formatting,
  browser-resolution denial, and independent Spec/Standards reviews with no
  blocker/high findings. Commit `786c23c` corrects the cancellation race at
  the executor boundary: cancellation still rejects before execution, while a
  result already confirmed by the executor remains truthful success and
  proceeds through bounded output validation, as required by ADR 007. The
  node-sdk and core-node suites remain green at 18 and 13 assertions.
- Commit `94426f7` adds the exact `core.manual@1`, `core.set@1`, and
  `core.terminate@1` definition/executor pairs in per-node definition,
  validation, and executor modules. It pins bounded-JSON and restricted-JSONata
  policies, exposes only browser metadata and schemas at the root, and exposes
  only compatibility, historical lookup, and execution from the server entry;
  placement/publication adapters remain intentionally absent. The package
  passes 13 focused assertions, typecheck, build, ESLint, formatting, root
  TypeScript build, frozen install, and an actual browser-condition server
  import denial. Independent incremental Spec and Standards reviews returned
  GO with no blocker/high findings.
- Commit `5e72a26` adds a retained Phase 2 `wf:v1` row verifier that preserves
  the original graph/checksum identity, requires every executable-envelope
  field to remain null, and returns an explicitly readable but non-executable
  result. The workflow-model package passes 48 focused assertions, typecheck,
  build, ESLint, formatting, and diff checks; an independent Spec/Standards
  review returned GO with no blocker/high findings. The combined V2/checksum
  checklist remains unchecked until the executable V2 envelope and retained
  fixtures are complete.
- Commit `10eed1b` replaces trusted checkpoint/graph inputs with an explicit
  server boundary: 256-KiB incremental JSON accounting, depth/member/array
  caps, strict own-data field parsing, proxy/accessor/symbol/cycle/sparse-array
  rejection, canonical workflow-model graph validation, and fresh private
  scheduler projection. The engine passes 49 focused assertions, typecheck,
  build, ESLint, formatting, and diff checks; an independent review returned
  GO after adversarial dense/wide allocation, hidden-property, and inherited
  behavior regressions were fixed.
- Commit `9d101ff` adds the engine-owned executable V2 envelope and
  `wf:v2:sha256` behavior identity without changing the authoring graph or V1
  checksum. It composes exact engine policies with a locked node release,
  canonically pins definitions, config/mappings, connections, disabled state,
  executors/ABI, applicable policies and original release provenance, and
  supports exact retained execution under compatible active/retained releases.
  Final-envelope limits, own-data normalization, active admission, manifest
  drift, policy-version matching, ordinal ordering, later-release invariance,
  retirement-blocked admission, deep freezing, mutation sensitivity, and the
  golden checksum are executable regressions. The engine now passes 58 focused
  assertions plus typecheck, build, ESLint, formatting and diff checks;
  independent Spec and Standards reviews returned GO with no blocker/high
  findings. Publication config-schema validation and the concrete executor
  adapter remain unchecked next-checkpoint work.
- Commit `5ea5075` makes verified V2 identity mandatory at the production
  `AdvanceWorkflow` and `ExecuteNodeAttempt` seams. It derives private scheduler
  state from the pinned envelope, binds run/workflow/node/attempt identities,
  validates checkpoints and root invocation keys, resolves only declared
  direct-upstream ValueSources under the restricted JSONata policy, propagates
  cancellation, preserves a result already confirmed by the executor, and
  returns bounded typed outcomes without leaking raw failures. Generic graph
  helpers moved to the server-only testing export, and deterministic code-unit
  ordering now covers scheduler/checkpoint/join/loop behavior. The engine passes
  64 focused assertions, typecheck, build, ESLint, formatting, worker fixture
  typecheck, and diff checks. Independent Spec and Standards re-reviews returned
  GO with no blocker/high findings after mapped-input overflow was classified as
  `attempt_invalid` and proven not to invoke the executor.
- Commit `83c57c6` adds migration head
  `0013_published_workflow_execution.sql`, preserving Phase 2 `wf:v1` rows while
  adding a total-valued immutable V1/V2 storage invariant, a 1-MiB database
  backstop, V2-only tenant RLS, and exact worker column grants that exclude the
  authoring graph and publication metadata. Readiness exact-matches the schema,
  constraints, policy, configured worker role, role attributes, and grants; the
  worker also rejects a connection authenticated as the wrong role. The narrow
  reader returns only an unverified `v2_projection` for the engine to verify and
  keeps the database package dependency-free from workflow semantics. Database,
  API, and worker suites pass 19, 169, and 41 unit assertions; an isolated clean
  migration and full PostgreSQL suite pass 140 assertions, and a separate
  retained-0012 upgrade preserves the V1 checksum with all executable columns
  null. Independent Spec and Standards reviews returned GO with no blocker/high
  findings. The shared local database remains safely at 0012 because its old
  recorded 0012 checksum differs from the checked-in migration; no migration
  history was bypassed or rewritten.
- Commit `e8da105` completes the pre-publication V2 identity by pinning the
  ADR 007 `safe | idempotent_with_key | unsafe` side-effect class in every
  executable node and copying that authenticated value into every attempt
  admission. One exhaustive compiler boundary maps the node-SDK manifest
  spelling, while parsing checks the pin against both admission and current
  releases and the behavior checksum includes it. Core scheduling no longer has
  a synthesized-safe fallback and fails closed when admission lacks explicit
  scheduler metadata. The V2 golden checksum changed before any V2 row could be
  published or durably admitted: publication remains disabled, the shared
  database is still at the V1-only 0012 schema, and the retained-V2 fixture box
  remains unchecked. The engine passes 68 assertions, workflow-model retains
  its 48 unchanged V1 assertions, and engine/worker typechecks, builds, lint,
  formatting, and independent Spec/Standards reviews are green. Stable provider
  provider effect keys remain deferred until the first side-effecting node in
  Phase 4; current Phase 3 core manifests are safe, the RunStore rejects
  non-safe admissions, and no consumer is enabled.
- Commit `d04f9f5` adds migration head
  `0014_execution_value_persistence.sql` and the private V1 persistence codec
  for tagged inline/artifact execution values. The application boundary
  enforces an exact 256-KiB inline value, depth 64, and 10,000 recursive members
  with bounded iterative allocation, strict own-data/Unicode/number semantics,
  cycle rejection, alias-safe cloning, and canonical serialization. Atomic run
  acceptance now stores optional input through a parameterized canonical
  `::jsonb` value, preventing inherited `toJSON` hooks from changing data after
  validation. PostgreSQL uses a documented 4-MiB coarse backstop on only the six
  future value/checkpoint columns because `jsonb::text` whitespace and exponent
  expansion do not match canonical bytes; legacy Phase 0E shapes remain valid.
  Database tests pass 43 unit and 150 isolated PostgreSQL assertions, including
  clean and retained-0013 migrations, exact/over/hostile values, scientific
  numbers, a checkpoint above the former 16-KiB bound, RLS/grants/readiness
  drift, rollback, replay, and prototype-pollution proofs. Spec and Standards
  reviews returned GO. Full checkpoint/version CAS and output persistence remain
  deliberately owned by the next RunStore checkpoints.
- Commit `8ce1fd9` deepens coordinator recovery around PostgreSQL-owned facts
  before the RunStore is enabled. The engine consumes every contiguous durable
  event sequence, including cursor-only start/progress facts and attempt-fenced
  waits, retries, outcomes, and cancellation, without re-emitting source-owned
  events; derived events begin strictly after the persisted high-water.
  Unsequenced database-clock deadline and due facts are distinct from the event
  cursor, deterministic, state-gated, and idempotent. Deadline and cancellation
  stop new materialization/admission while preserving running-attempt truth,
  and every newly materialized invocation now has an explicit deterministic
  node-run admission independent of the attempt cap. Checkpoint output locators
  are canonical UUID-backed attempt or artifact identities, and inline outcomes
  must reference the completing attempt. Persisted attempt outcomes explicitly
  reject coordinator-owned `skipped`. Workflow-engine, workflow-model, and
  worker suites pass 79, 48, and 41 assertions respectively, with typecheck,
  builds, ESLint, formatting, diff checks, and independent Spec/Standards
  reviews green. Commit `a8c52aa` subsequently completes the physical
  attempt/artifact ownership, valid revision-0 acceptance checkpoint, and
  atomic CAS/event/node-run/attempt/outbox prerequisites; no consumer is yet
  enabled.
- Commit `a8c52aa` adds migration head `0015_coordinator_run_store.sql`, a deep
  `CoordinatorRunStore` with `loadAdvanceState` and `commitAdvancePlan`, and
  makes a validated revision-0 Phase 3 checkpoint part of the atomic accepted
  run. The adapter keeps transactions, SQL, physical IDs, RLS, CAS, event
  cursor reconciliation, output/artifact ownership, transition fingerprints,
  and identifier-only outbox insertion behind the behavior seam. It consumes
  PostgreSQL-owned facts under a coherent snapshot, validates the complete
  engine plan and physical-state delta before a short locked commit, and
  handles exact replay, stale control facts, capacity-deferred node runs,
  due-at recovery, cancellation/deadline fencing, and rollback without enabling
  a worker consumer. Persisted event payloads are safely canonicalized with an
  exact 4-KiB application boundary; the wider 512-KiB PostgreSQL text backstop
  accommodates JSONB whitespace/numeric expansion, while keyset reads bound
  transient allocation and immediately compact every fact back to the exact
  canonical limit. A fresh disposable PostgreSQL database migrated from zero
  through 0015 and passed all 182 database integration assertions, including
  retained upgrade, RLS/grant/readiness drift, concurrent CAS, exact replay,
  failpoint rollback, hostile single/aggregate payloads, 10,000-fact cursor
  recovery, and 450 valid exponent-heavy facts whose PostgreSQL text exceeds
  64 MiB. The database unit suite passes 48 assertions; root `pnpm check`
  passes formatting, lint, generated-contract drift, all workspace typechecks,
  518 unit assertions, and all builds. Independent final Spec and
  Standards/security reviews returned GO with no blocker/high findings. The
  disposable database catalog was empty after cleanup, and the shared local
  database was not mutated.
- Commit `9d8d3c5` composes the production workflow coordinator around the
  published-version reader, authenticated V2 engine, and RunStore, and exposes
  `advance-workflow-run` to the dispatcher only when that exact consumer is
  composed and ready. Migration `0016_engine_invocation_keys.sql` admits the
  engine's canonical URI-component invocation identity while retaining legacy
  Phase 0E rows. The transport path binds each BullMQ delivery to its durable
  outbox aggregate and canonical checksum, records the inbox receipt in the
  same transaction as the checkpoint transition, makes exact redelivery a
  no-op, and records a durable security audit fact before rejecting a forged
  payload that reuses a valid outbox ID. Readiness now proves the coordinator's
  exact outbox/inbox/audit policies and least-privilege grants. A clean
  zero-to-0016 PostgreSQL run passes all 183 database integration assertions;
  the real PostgreSQL + Redis + BullMQ coordinator proof passes two transition,
  exact-redelivery, and forged-delivery cases. Root `pnpm check` passes
  formatting, lint, generated-contract drift, all typechecks, 530 unit
  assertions, and all builds. A final two-axis checkpoint review found no
  blocker/high issue. The disposable database was dropped; attempt execution
  and publication remain disabled.
- Commit `bbf7535` fixes successor liveness by deriving downstream readiness in
  the same transition that consumes a persisted terminal attempt fact. This
  preserves the source-owned event cursor while atomically emitting the next
  `node.ready`, node-run admission, attempt, and outbox work; the engine remains
  deterministic and passes 79 assertions.
- Commit `929b1d8` adds the deep `NodeAttemptRunStore`. It binds the IDs-only
  BullMQ delivery to the durable outbox checksum, atomically claims a bounded
  lease and monotonic fence, reconstructs only bounded run/direct-upstream
  inputs, records the dispatch marker, heartbeats PostgreSQL-owned cancel/deadline
  truth, and commits the exact terminal attempt/node/event/continuation/receipt
  transaction. Canonical UUIDs, stale ownership, exact terminal replay,
  conflicting output, active-lease redelivery, and forged outbox reuse fail
  closed or become the required no-op; forged reuse records a durable transport
  security fact.
- Commit `d06b370` composes the real node-attempt engine/handler/consumer and
  exposes `execute-node-attempt` to dispatch only when that exact consumer is
  composed and ready. Execution verifies the pinned V2 envelope, reads only
  direct upstream values, marks dispatch immediately before the executor,
  heartbeats outside database transactions, cooperatively aborts on durable
  cancellation/deadline, preserves confirmed success, and emits continuation
  work. The real PostgreSQL + Redis + BullMQ proof executes Manual -> Set/Map ->
  Terminate with literal, run-input, upstream-output, and restricted-JSONata
  mappings, replays every attempt delivery without duplicate effects, and ends
  with one canonical terminal event/state.
- Root `pnpm check` is green at this checkpoint: formatting, ESLint, generated
  contract drift, all workspace typechecks, 544 unit assertions, and all
  production builds. A fresh disposable PostgreSQL database migrated from zero
  through `0016_engine_invocation_keys.sql`; the full database suite passed 184
  assertions, and the real worker proof passed three coordinator/attempt
  cases. All disposable databases were dropped (`pertexo_test_% = []`); the
  stale shared development database was not reset or rewritten. At
  `d06b370`, API/SSE/cancellation/publication and durable compatibility/final
  review were still the next checkpoints; the following evidence records which
  of those gates are now closed.
- Commits `27e1720` and `c57e89e` add generated Start/Get/Stream/Cancel
  contracts plus the authorization-first application/controller seams. Commit
  `d397f72` adds the deep PostgreSQL command adapter: exact start replay resolves
  before current publication state, new acceptance atomically writes the
  immutable version/run/checkpoint/event/idempotency/outbox set, Get returns a
  bounded purpose-built projection, and cancellation writes its durable event,
  continuation outbox, and audit once. Focused database integration proves one
  run/checkpoint, two source events, two outbox rows, and two audits across
  exact start/cancel replays, request-hash conflict, and cross-workspace reads.
- Commits `61f8f0c`, `56acb98`, and `88fcf4d` move the opaque hashed-channel
  Redis notification transport into the queue owner and publish best-effort
  resync hints after committed coordinator and node-attempt transitions. Redis
  remains non-authoritative: API Start/Cancel and worker handlers never change
  a committed PostgreSQL result when a hint fails, and SSE always rereads
  ordered durable events.
- Commit `a7eaf42` activates the complete public slice. Production authoring
  adapts the core registry without reversing graph ownership, compiles the
  exact V2 envelope inside the locked publication transaction, preserves V1
  read/checksum behavior, and publishes a V2 checksum contract. The workflow
  runtime composes run persistence, PostgreSQL event reads, opaque Redis hints,
  bounded public payload projection, lifecycle cleanup, and the four NestJS
  routes. A real authenticated HTTP/PostgreSQL/Redis proof publishes the
  Manual -> Terminate core graph, returns `202`, exactly replays the original
  run, rejects a changed request with the stable 409 problem, reads and cancels
  under CSRF/RLS, verifies the one-run/one-checkpoint/two-event/two-outbox
  durable cardinality, strips cancellation actor/reason from SSE, and hides a
  foreign workspace.
- At `a7eaf42`, root `pnpm check` passes formatting, ESLint,
  deterministic generated-artifact drift, all workspace typechecks, 559 unit
  assertions, and all production builds. On the isolated PostgreSQL 18
  database already migrated through `0016_engine_invocation_keys.sql`, focused
  database suites pass 38 assertions, the authenticated real API suite passes
  six end-to-end cases, the real PostgreSQL/Redis SSE proof passes, and the real
  PostgreSQL/Redis/BullMQ coordinator proof passes three cases. At that point
  active-work cancellation/restart, durable compatibility-release/fleet
  authority, retained compatibility, and final Phase 3 review remained open.
- Commits `6e28d20` and `85f0b4c` bind authoring compatibility tags, V2
  executable provenance, publication, new run admission, worker version reads,
  and API/worker readiness to one engine-derived compatibility epoch,
  full-release fingerprint, and canonical catalog. Migration
  `0017_node_compatibility_releases.sql` stores the immutable audited release
  and singleton current pointer; serving roles can only read or take the
  same-transaction share lock. Exact completed command replays resolve before
  current-release comparison, while distinct mixed-release commands fail
  closed. Clean/upgrade PostgreSQL, authenticated API, worker transport, and
  real publication-vs-pointer-lock proofs are green.
- Commit `37ce837` restores the shared Phase 0E process fixture to the active
  workspace admission and explicit scheduler-state contracts. The full five-
  case process-boundary matrix passes: coordinator crashes on both sides of
  checkpoint CAS, Redis restart wait recovery, attempt crashes before/after
  provider dispatch, cooperative cancellation through Redis loss with one
  confirmed effect, and cancellation-fenced branch/all-any-count join/three-
  iteration loop reconstruction. Worker unit/typecheck/build/lint/format gates
  pass at 64 assertions.
- Commit `de23aee` retains one immutable production-core V2 graph, executable
  envelope, selection/release fingerprints, and
  `wf:v2:sha256:41379300875e74902768205f533500fb1c6f50cdc91e649a119de02c990f2fe8`.
  Rebuilding against the actual core release is byte-identical; exact Manual,
  Set/Map, and Terminate definition/executor pairs produce their canonical
  results, while executor-version substitution fails closed. Together with
  the retained `wf:v1` non-executable fixture and retained/retired engine
  lifecycle tests, every Phase 3 executable format and core pair has retained
  evidence.
- Commit `31877e8` records and enforces separate definition and executor
  successor transitions in the node SDK. Successors cannot skip lifecycle
  gates, change compatibility behavior under an existing identity, add an
  executor outside `staged`, or remove a definition/executor before `retired`;
  placement, publication, historical, active/retained execution, and exact-
  version failure tests remain green at 20 node-SDK assertions.
- Commit `66dafb7` advances the migration head to
  `0018_phase3_core_executor_non_removal.sql`. A PostgreSQL insert guard makes
  the Phase 3 non-removal invariant durable: every future release must contain
  exactly one `core.manual@1`, `core.set@1`, and `core.terminate@1` executor in
  `active` or `retained`. Clean and `0017` upgrades accept the real retained
  successor and reject omitted, blocked, retired, staged, or duplicated core
  identities; readiness attests the exact trigger/function body, owner,
  search path, ACL, and enabled state. The database package passes 55 unit and
  196 full PostgreSQL integration assertions; API 183 and worker 64 unit tests,
  all affected typechecks/builds, ESLint, formatting, and diff checks are
  green.
- Commit `111a049` advances the migration head to
  `0019_node_compatibility_preactivation.sql`. The transaction-owning
  deployment-maintenance seam prepares only the next release epoch, records
  immutable API/worker artifact checks against the exact durable target,
  rejects incomplete named cohorts, persists an immutable approval, and moves
  the singleton pointer under its predecessor lock only after revalidating the
  approved cohort. Exact maintenance retries are stable, serving roles cannot
  read the deployment evidence or execute maintenance functions, and normal
  readiness accepts at most the current/next exact release pair while the
  separate target probe validates a prepared non-current release. Clean and
  `0018` upgrade PostgreSQL runs pass 199 assertions; the root static gate
  passes 568 unit assertions, all typechecks, generated drift, lint, formatting,
  and builds.
- Commit `6a5f43c` makes the additive overlap executable by one real artifact.
  The engine accepts only one validated current-to-next successor pair and
  resolves exact epoch/fingerprint identities without a latest fallback;
  nodes-core binds the same immutable Manual, Set/Map, and Terminate
  implementations to a lifecycle-only successor while rejecting gaps or
  unimplemented identities. API and worker database readiness use the bounded
  expected-set path. The real 0019 rollout proof prepares the target, runs
  separate API and worker target probes, records the named cohort, approves and
  activates it, keeps the overlap artifact ready, and makes the old API artifact
  fail closed. Strong draft ETags differ across the actual current/target
  fingerprints. The root gate passes 572 unit assertions and the focused
  PostgreSQL rollout proof passes on a fresh zero-to-head database.
- Commit `7487ae6` closes the production overlap gap across every serving path.
  API authoring and run admission, worker coordinator and node-attempt loading,
  and readiness all resolve the exact durable current release from the bounded
  old/target support set without a latest fallback. Authoring now separates an
  active-only placement catalog from the active/deprecated publication catalog
  and compares every root or structured-body node occurrence with the prior CAS
  revision. A deprecated definition is grandfathered only for one unambiguous
  stable node ID/definition pair; direct, cloned, duplicate-ID, identity-swapped,
  and nested new placements fail with the stable workflow problem while the
  draft remains unchanged. The fresh rollout proof saves Manual before target
  activation, publishes that retained instance afterward, rejects every
  postactivation placement bypass, keeps the overlap artifact ready, and makes
  the old-only artifact fail closed. Independent final Spec and Standards
  reviews returned GO with no blocker/high findings.
- At fixed implementation commit `7487ae6`, root `pnpm check` passes formatting,
  ESLint, deterministic generated-contract drift, every workspace typecheck,
  575 unit assertions, and every production build. On a fresh PostgreSQL 18.6
  database migrated from zero through
  `0019_node_compatibility_preactivation.sql`, the root sequential real-service
  matrix passes 217 assertions: two S3Mock 5.1.0 object-store, 199 database,
  nine worker/PostgreSQL/Redis/BullMQ, and seven API/PostgreSQL/SSE assertions.
  The dependency-ordered `pnpm test:integration` suite durations are 0.33 s,
  14.50 s, 4.40 s, and 6.22 s respectively.
  The separate fresh rollout assertion passes after exact API/worker target
  probes and activation. The five-case Phase 0E process matrix passes in
  41.90 s, including Redis restart recovery in 7.14 s, cancellation recovery in
  12.39 s with one confirmed effect, exact join policies, loop concurrency two,
  and three iterations. The destructive transport proof passes against Redis
  8.2.8 and BullMQ 6.1.2 with queue-loss recovery in 1.13 s, Redis recovery in
  5.74 s, PostgreSQL recovery in 5.71 s, zero post-drain claims, and bounded
  close; PostgreSQL remains authoritative. The SSE Redis-loss proof backfills
  from PostgreSQL in 5.82 s. Fixed-head compiled-process smoke checks start an
  API that reports live/ready and the worker with both Phase 3 dispatch
  consumers ready; `SIGTERM` closes them cleanly in 85 ms and 82 ms
  respectively. Together with the lifecycle and destructive-drain assertions,
  this proves readiness falls before shutdown, no post-drain claim occurs, and
  resources close within the bounded signal window. All explicit disposable
  databases were dropped, Redis test databases were flushed, no
  `pertexo_test_%` database remained, and PostgreSQL, Redis, and the object store
  were healthy after cleanup.

## Phase 4 — First side-effecting integration slice

Status: **Complete**

Phase 4 must ship the first complete side-effecting vertical slice: create and
use one encrypted generic-HTTP connection, publish and execute the generic HTTP
Request node safely, and validate or test that node through an isolated bounded
preview. Nothing becomes publishable merely because its schema, controller, or
manifest exists.

Design prerequisites and scope:

- [x] Expand this tracker with the exact Phase 4 scope, exclusions, coherent
      checkpoints, and completion evidence required by the authoritative plan.
- [x] Keep accepted ADR 007 authoritative for dispatch evidence, retry,
      provider idempotency, cancellation, reconciliation, and
      `outcome_unknown`.
- [x] Review and accept ADR 016 for read-only validation, explicit
      side-effecting test execution, preview isolation, idempotency, retention,
      and bounded values before implementing the node-test API.
- [x] Add canonical Connection, Connection secret version, connection health,
      HTTP Request, Preview run, and preview-attempt vocabulary/constants without
      introducing generic CRUD or provider base modules.
- [x] Keep Slack, email, OAuth completion, webhooks, Schedule, orchestration
      nodes, polling, and production operations outside this phase.

Connection and secret vertical slice:

- [x] Add strict public create/test connection contracts, generated client and
      OpenAPI artifacts, stable RFC 9457 problem codes, opaque identifiers, and
      safe responses that never return credential material.
- [x] Add tenant-scoped `connections`, immutable
      `connection_secret_versions`, and append-only `connection_events` with
      forced RLS, least-privilege API/worker grants, same-connection current
      pointer constraints, lifecycle/status constraints, and safe indexes.
- [x] Implement AES-256-GCM envelope encryption through a narrow managed-KMS
      seam: one generated data key per immutable secret version, authenticated
      workspace/connection/secret-version context, no plaintext database
      columns, fail-closed context mismatch, key rotation by new secret version,
      and zero secret material in thrown errors.
- [x] Implement authorized create/rotate/test/revoke behavior and just-in-time
      worker resolution. Recheck workspace, connection usability, provider/auth
      compatibility, and `connection:use` immediately before decryption.
- [x] Record safe connection and credential-access audit facts, connection
      health events, traces, bounded metrics, and stable redacted failures.
- [x] Prove exact/conflicting request retries, transaction rollback, concurrent
      name/current-version changes, revocation races, cross-workspace isolation,
      ciphertext swapping/context failure, KMS failure, and serving-role grants
      against real PostgreSQL plus the production encryption adapter contract.

Generic HTTP Request vertical slice:

- [x] Add one browser-safe `http.request@1` action definition and separately
      server-only executor with versioned strict config/input/output schemas,
      connection requirements, timeout/redirect/response limits, exact retry
      class, resource class, capabilities, and compatibility-release identity.
- [x] Add a deep HTTP execution module whose small interface owns URL parsing,
      allowed schemes, DNS resolution and rebinding-resistant address pinning,
      private/link-local/loopback/metadata-range rejection for IPv4 and IPv6,
      redirect re-resolution, bounded redirects, method/body/header policy,
      timeout/abort, response streaming/size bounds, safe error taxonomy, and
      redaction.
- [x] Reject user-info URLs, credential-bearing or hop-by-hop headers, unsafe
      protocol changes, invalid DNS results, mixed public/private answers,
      oversized requests/responses, and every redirect or DNS hop that no longer
      satisfies policy. Generic API utilities must not become an alternate
      user-URL fetch path.
- [x] Resolve connection-backed headers only inside the worker immediately
      before dispatch; graph JSON, executable envelopes, jobs, checkpoints,
      events, outputs, logs, traces, metrics, and public problems retain only
      opaque connection IDs and redacted metadata.
- [x] Commit ADR 007 dispatch evidence before network I/O. Exercise `safe`,
      `idempotent_with_key`, and `unsafe` policy explicitly; reuse the stable
      provider key on every permitted retry; expose adapter retry hints without
      hidden SDK retries; classify definite, retryable, rate-limited, timeout,
      canceled, and ambiguous transport outcomes truthfully.
- [x] Persist bounded structured output inline at or below the declared limit
      and stream larger/unsuitable responses to a workspace-scoped artifact;
      downstream resolution must consume the canonical stored value only.
- [x] Add `workflow_integration_usage` as a transactionally rebuilt projection
      of the immutable published graph and prove provider/operation/connection
      impact and revocation queries without making it a second graph authority.
- [x] Keep `http.request@1` absent from placement/publication/admission until
      its connection, security, execution, artifact, telemetry, compatibility,
      and failure gates all pass; then prove additive old/new API-worker rollout
      and retained Phase 3 execution with no latest-version fallback.

Validate and test-execute preview vertical slice:

- [x] Add a strict discriminated node-test request contract. `validate` pins an
      expected draft revision, resolves mappings/sample input and schemas, and
      returns bounded field-addressed issues plus side-effect disclosure without
      decrypting credentials, resolving DNS, queueing work, or contacting a
      provider.
- [x] Require explicit side-effect acknowledgement and request idempotency for
      `test_execute`; accept bounded manual input or one same-workspace,
      same-workflow, successful, unexpired prior-preview output reference.
- [x] Persist an immutable short-retained Preview run and preview attempt with
      pinned draft/release/node/executor identity, actor, trace context, input/
      output references, disclosure, dispatch/lease evidence, and truthful
      terminal state. Return `202` and execute only in the worker through an
      identifier-only outbox/queue job.
- [x] Keep preview execution separate from workflow versions, production runs,
      checkpoints, trigger state/cursors, production SSE, and reusable
      production input. Audit and meter it through safe scoped facts.
- [x] Apply the production bounded-value/artifact, redaction, credential,
      timeout, retry, cancellation, duplicate-delivery, reconciliation, and
      `outcome_unknown` policies to preview execution (inline bounded values,
      duplicate delivery, mapped input, unsafe deadline truth, fenced reclaim,
      side-effect-aware reconciliation decisions, and automatic durable
      reconciliation delivery, artifact-backed outputs with inherited
      retention, authorized bounded deletion, terminal audit/usage facts, and
      terminal cardinality-safe runtime metrics are proven).
- [x] Prove authorization and cross-workspace denial, stale draft conflicts,
      validation purity, disclosure/acknowledgement, exact and conflicting
      request retries, duplicate jobs, every pre/post-dispatch crash boundary,
      timeout/cancel, ambiguous unsafe outcomes, prior-preview scope/expiry,
      bounded inline/artifact output, safe status reads, and retention cleanup.

Phase-wide verification and evidence gates:

- [x] Exercise every new contract's success, rejection, unknown-key, version,
      and generated-artifact drift behavior; retain compile-time registry and
      server-only package-boundary proofs.
- [x] Prove authorization, tenant scope, use-case transactions, real adapters,
      stable problems/safe logs, traces/metrics/audit/usage effects,
      idempotency/retry/timeout/cancellation, API/job documentation, and unit,
      real integration, happy-path, failure, crash, and security behavior for
      each released connection/node/preview capability.
- [x] Re-run all Phase 0D/0E and Phase 3 compatibility/recovery fixtures after
      the side-effecting registry release, including Redis loss, PostgreSQL
      loss, SSE reconstruction, duplicate delivery, cancellation, process
      termination/drain, and retained-old-version execution.
- [x] Run root `pnpm check`, clean zero-to-head and prior-head migration paths,
      and the complete real-service integration matrix sequentially. Record
      exact commands, versions, assertion counts, timings, migration head,
      cleanup, and post-test dependency health.
- [x] Complete independent Spec and Standards reviews against one fixed Phase 4
      implementation commit and resolve every blocker/high finding.
- [x] Mark Phase 4 complete only after every box above has direct evidence and
      the coherent implementation/evidence commits are pushed.

Explicit exclusions for Phase 4:

- No universal dry-run promise, API-process node execution, plaintext secret
  persistence, credentials in graph/queue/event/output data, unbounded provider
  bodies, or automatic retry of an unsafe possibly dispatched effect.
- No arbitrary URL-fetch helper exposed outside the policy-enforcing HTTP
  execution module, DNS decision based only on the original hostname, redirect
  trust inheritance, SDK-owned hidden retries, or claim of exactly-once effects.
- No production scheduler mutation, published-version creation, trigger cursor
  update, or production SSE event from a preview.
- Existing Phase 0 artifact metadata/store proofs are foundations, not Phase 4
  completion evidence until HTTP and preview outputs exercise the full bounded
  inline/artifact lifecycle.

Planned coherent checkpoints:

1. Accept ADR 016 and record the complete Phase 4 checklist before code.
2. Land connection persistence, envelope encryption, contracts, authorization,
   API behavior, telemetry, and real database/KMS-adapter proofs.
3. Land the policy-enforcing generic HTTP package and its exhaustive network,
   SSRF, timeout, redaction, retry-class, and response-bound fixtures.
4. Land the publishable HTTP definition/executor, exact compatibility rollout,
   integration-usage projection, just-in-time credentials, production dispatch,
   and artifact-backed output behavior.
5. Land validate/test-execute preview acceptance, worker execution, durable
   outcomes, status, cleanup, audit/usage, and crash/duplicate/security proofs.
6. Record the fixed-head full regression matrix and independent completion
   reviews, then mark Phase 4 complete only if every criterion is proved.

Current evidence:

- ADR 016 is accepted on 2026-08-22. It separates pure validation from
  explicitly acknowledged durable test execution, pins preview identity,
  isolates production state, and applies ADR 007 truth plus bounded artifacts.
- The server-only `@pertexo/integrations` foundation composes AES-256-GCM with
  a managed-KMS data-key seam. It authenticates workspace, connection, and
  secret-version identities in both KMS encryption context and AEAD associated
  data, bounds all cryptographic material, clears plaintext key copies, exports
  no credential implementation to browsers, and collapses malformed/context/
  KMS failures into one safe error. Five focused typechecked assertions cover
  exact round trips, context/ciphertext swapping, size failures, AWS KMS command
  context, and safe upstream failure handling; package lint and build pass.
- Migration `0020_connections.sql` adds forced-RLS connection metadata,
  same-connection deferred current-secret identity, immutable encrypted secret
  versions, and append-only safe connection events. API grants can create and
  rotate but cannot rewrite history; worker grants can resolve only current
  secrets, record health/access facts, and cannot create connections. The
  persistence module provides exact/conflicting create idempotency, active-name
  uniqueness, secret-version CAS rotation, idempotent revocation, provider/
  lifecycle-gated just-in-time resolution, and bounded health truth. Seven
  fresh PostgreSQL 18 assertions pass for clean zero-to-0020 and supported
  0019-to-0020 migration, API/worker readiness, rollback, pointer/FK isolation,
  cross-workspace RLS, immutable triggers, grants, health, and credential-access
  events; 56 database unit assertions, package typecheck, lint, and build pass.
- Commit `aa4b25b` composes managed AWS KMS configuration and the connection
  runtime into the API, adds strict create/rotate/revoke contracts and generated
  OpenAPI/client artifacts, and exposes guarded `connection:manage` commands.
  Create and rotation idempotency now persist the original secret-free response
  snapshot and resolve exact retries before KMS, including after later secret
  rotations; conflicting retries remain stable `409` problems. Credential
  headers are case-insensitively canonicalized, byte/count bounded, reject
  transport-controlled headers and control delimiters, and never appear in a
  response. Application plaintext byte buffers and generated data-key copies
  are cleared on every success/failure path. The API runtime reports only
  bounded operation/outcome telemetry and closes its database/KMS resources.
  Verification at this checkpoint passes 201 API assertions (including a real
  Nest/Fastify guard-controller stack), 10 contract assertions plus generated
  artifact drift, 56 database unit assertions, seven fresh PostgreSQL 18
  connection assertions, and five production encryption-adapter assertions;
  all affected packages typecheck/build and every changed source/test path
   passes ESLint. The full repository lint command exceeded Node's default 4 GiB
   heap during this checkpoint, so it is not used as evidence for Phase 4
   completion. Commit `1b8af29` on `fix/audit-findings` later gave the root
   lint script an explicit bounded heap, restoring the repository-wide gate.
- Commit `ce02e52` closes the remaining connection-slice failure-proof box
  with real concurrency on fresh disposable PostgreSQL databases. Eleven
  focused assertions now prove: simultaneous same-name creations admit
  exactly one winner, reject the loser with the stable conflict problem, and
  leave exactly one immutable secret version; simultaneous rotations from one
  expected current pointer admit exactly one CAS winner, fail the loser with
  `ConnectionSecretVersionConflictError`, advance the pointer once, and never
  persist the losing version regardless of race order. Earlier checkpoints in
  this slice already proved exact/conflicting retries, create/rotate replay,
  rollback without partial rows, stale-pointer conflict, revoke-before-
  resolve, rotate-during-test stale-completion isolation, cross-workspace
  hiding, forced-RLS/grant catalogs, history-mutation denial, and readiness.
  The production encryption adapter contract is covered by
  `packages/integrations/test/envelope-encryption.test.ts`: authenticated
  workspace/connection/secret-version context round trip, tampered-ciphertext
  and swapped-workspace rejection, one safe collapsed error without cause for
  KMS failures, bounded material sizes, issued-key zeroization, and exact AWS
  KMS encryption-context binding. Database typecheck, scoped ESLint, and
  Prettier pass; the suite ran twice to shake race-order flakiness.
- Commit `bd2989b` closes the ADR 007 dispatch-evidence box for the staged
  HTTP slice. The executor keeps its manifest-pinned `unsafe` identity, and
  the complete outcome vocabulary is now exercised at both the policy layer
  (`http-outcome-policy.test.ts`: all three side-effect classes, stable
  provider-key reuse exactly when permitted, closed error taxonomy) and the
  executor boundary (`http-request.test.ts`): post-dispatch 429 is a definite
  rate-limited failure with zeroized body bytes; ambiguous post-dispatch
  timeout becomes `outcome_unknown`; pre-dispatch timeout is a truthful
  bounded retry with no dispatch marker committed; cancellation after the
  durable marker propagates the transport's own dispatch truth as `canceled`
  rather than a provider or unknown disguise. Combined with the earlier
  worker ordering proof (executor start -> durable dispatch marker ->
  provider I/O), every enumerated transport outcome now has executable
  evidence before activation. Integrations suite passes 78 assertions;
  focused typecheck, ESLint, and Prettier pass.
- Commit `21a0b1d` opens the preview execution checkpoint with the
  worker-side persistence seam beside acceptance. Deliveries bind to their
  durable outbox aggregate by recomputed canonical checksum; claims CAS the
  single attempt from queued to running under a monotonic fence token with
  expired-lease reclaim; heartbeats
  extend only the owning lease and report both attempt and retention
  deadlines; completions reject stale fences as truthful duplicates while
  syncing run status/output/error in one transaction under the migration's
  exact terminal-shape and output-truth constraints. The initial reconciliation
  rule in this commit was incomplete; `5dfb5f0` corrects it so undispatched,
  safe, and stable-key work is reclaimable while only unsafe possibly-
  dispatched work becomes `outcome_unknown`. Forged checksum reuse commits a
  tenant-scoped transport security fact
  before failing closed; cross-workspace claims are hidden by forced RLS.
  All mutations run through this branch's shared fail-closed transaction
  primitive. Six focused real-PostgreSQL assertions pass on a fresh
  disposable database, and the repository-wide fresh-database integration
  matrix passes 249 assertions (two object-store, 230 database across 16
  files, ten worker, seven API) with the disposable database dropped
  afterward. The handler/consumer composition, crash-boundary proofs, and
  retention cleanup remain open before preview execution can activate.
- Commit `2c1418a` initially composes preview execution onto the shared BullMQ
  attempts queue behind an explicit job-kind router. The deep handler
  claims through the durable seam, wraps raw executor payloads into the
  strict stored-value envelope — failing closed via a lossless canonical
  roundtrip plus structural JSON walk that rejects functions, symbols,
  bigints, class instances, and host objects without silent truncation —
  heartbeats the retention deadline and races it against execution so a
  result resolved before expiry stays truthful while an expired run
  completes `preview.deadline_exceeded`, and maps executor decision errors
  through ADR 007 truth: pre-dispatch retryable failures complete as
  `failed` with stable error-kind codes, possibly-dispatched ambiguity
  becomes `outcome_unknown`, cancellation remains `canceled`, and
  infrastructure faults propagate for bounded queue retries without
  fabricating provider truth. The platform invoker resolves only the exact
  pinned epoch/fingerprint from this artifact's compatibility history with
  no latest-version fallback; unsupported identities fail closed as
  `preview.executor_unavailable`. `execute-preview-attempt` joins the
  dispatcher capability allowlist, and its serving-role store composes
  only when that kind is enabled, closing its pool with the consumer.
  The tests at that head passed, but the later fixed-head review found raw
  input bypassing mappings, API/worker release-identity drift, false unsafe
  timeout truth, missing preview-only readiness/JIT capability composition,
  and startup cleanup gaps. Commit `dd0d665` corrects those defects and removes
  the unsupported retention-sweep placeholder. At that historical checkpoint,
  automatic reconciliation, artifact-backed output, terminal
  audit/usage/metrics, pre/post-dispatch SIGKILL boundaries, prior-preview HTTP
  evidence, and retention deletion remained open before activation; the later
  reconciliation and artifact-retention checkpoints below close only those
  named portions.
- Commit `886cdb3` closes the real-transport delivery proof. The suite
  provisions its own disposable PostgreSQL database, migrates through the
  shipped CLI path, and activates this worker artifact's derived release
  through the audited maintenance seam — prepare, API/worker target
  probes, named preactivation cohort, approval, and activation against
  the seeded predecessor — instead of trusting the migration bootstrap
  fingerprint. An accepted preview then flows acceptance -> outbox ->
  BullMQ (deterministic `outbox-<id>` job) -> routed consumer -> platform
  invoker -> pinned core.set executor, completing succeeded with the
  canonical stored-value envelope. The inbox receipt completes atomically
  inside the business transaction; a safe node truthfully records no
  dispatch marker; an exact redelivery leaves fence, outcome, and receipt
  byte-for-byte untouched. Seam completions now require the delivery
  identity so receipt completion cannot be skipped. Focused verification:
  nine handler unit assertions, six real-PostgreSQL seam assertions, one
  real-transport assertion; repository-wide `pnpm check` and the
  fresh-database matrix (250 database-side assertions across the new
  suites included) remain green. Remaining before activation: pre/post-
  dispatch SIGKILL crash boundaries through the composed handler,
  prior-preview scope/expiry e2e evidence, safe status reads over HTTP,
  and the authorized retention lifecycle.
- Commit `dd0d665` is the mandatory corrective successor to the initial
  preview-composition checkpoint. API acceptance now pins the engine-composed
  compatibility identity used by workers; preview execution validates its
  persisted node snapshot and resolves `ValueSource` mappings through the same
  production workflow-engine path; pre-expired work never invokes; unsafe
  post-dispatch deadline ambiguity becomes `outcome_unknown`; heartbeat
  authority loss commits no fabricated cancellation; and duplicate dispatch
  markers fail closed. Nest composes a shared attempts consumer for preview-
  only deployments, advertises readiness only for enabled jobs, supplies the
  same production connection/artifact factories, and closes the preview store
  on construction failure. The unsupported `sweep-expired-previews` contract
  is removed until a real authorized consumer exists. Focused formatting,
  ESLint, affected builds/typechecks, 57 database, 35 queue, 83 workflow-engine,
  97 worker, and 219 API unit assertions pass.
- Commit `5dfb5f0` corrects preview lease reconciliation to follow ADR 007 by
  side-effect class. Expired redelivery reclaims undispatched work and
  dispatched `safe` or `idempotent_with_key` work (preserving the stable key);
  only an expired unsafe dispatch is terminally reconciled as
  `outcome_unknown`. Six real-PostgreSQL preview-worker scenarios pass. The
  durable automatic mechanism that schedules such reconciliation/redelivery
  remains an activation blocker and is not delegated to BullMQ retry counts.
- Commit `d44ce6b` closes the final fixed-head review blocker: cancellation
  raised by the production mapping resolver before provider dispatch now maps
  to the canonical canceled preview outcome instead of
  `preview.executor_failed`. Its regression aborts before mapping, proves the
  executor is never called, and leaves ADR 007 dispatch truth intact. Preview
  composition also expresses its durable run store as required rather than
  defending against an impossible optional state. All 98 worker assertions
  and repository-wide `pnpm check` pass. Independent Standards and Spec
  reviews against exact head `d44ce6bcf5a705cfa89d8dae1fbf97724c099edb`
  report no blocker/high merge finding; they retain the explicitly unchecked
  Phase 4 activation gates.
- Commit `b850f53` adds the automatic durable preview-reconciliation path
  required by ADR 007. Every successful claim atomically creates a delayed,
  fence-bound `reconcile-preview-attempt` outbox delivery on the maintenance
  queue. The deep PostgreSQL module validates the checksum-bound delivery and
  inbox receipt, reschedules while the database lease is live, fences an
  expired owner before atomically redelivering undispatched/safe/stable-key
  work, stops redelivery after the run deadline, and records
  `outcome_unknown` for unsafe possibly-dispatched work. PostgreSQL clocks,
  lease state, and outbox rows remain authoritative; Redis/BullMQ only deliver.
  Exact duplicate wake-ups are no-ops and startup/readiness/shutdown compose
  the maintenance consumer explicitly. Verification passes root `pnpm check`
  (queue 36, observability 32, worker 103 unit assertions), 11 focused fresh-
  PostgreSQL scenarios, and two fresh-PostgreSQL/Redis transport scenarios,
  including a committed unsafe dispatch marker followed by lease abandonment
  and automatic terminal reconciliation. Those semantic crash boundaries do
  not substitute for process-level injection through the production handler,
  provider dispatch, and queue-acknowledgement path.
- Commit `963648c` adds real process-death persistence evidence for the
  automatic path. Five child processes commit a claim, dispatch marker, or
  terminal outcome through the production PostgreSQL seam and are then killed
  with `SIGKILL`. The PostgreSQL outbox reaches the real BullMQ maintenance
  consumer: claim-only/safe/stable-key work is fenced and requeued, the
  provider key remains byte-identical, unsafe marked-dispatched work becomes
  `outcome_unknown`, and the already committed failure remains unchanged. All
  five reconciliation inbox receipts complete once. Because the child fixture
  invokes database seams directly, this does not prove production handler or
  provider execution, nor the exact outcome-commit-before-queue-ack boundary;
  that full process-level crash matrix remains open. The fresh database is
  migrated zero-to-`0022`, the three-scenario worker transport file passes in
  4.84 seconds and drops its database, and root `pnpm check` remains green.
- Commit `b9b93fc` corrects immediate execution redelivery to use PostgreSQL
  `clock_timestamp()` rather than a worker's wall clock. Its real-PostgreSQL
  regression moves the JavaScript clock to 2099 and still observes the
  replacement outbox row within five seconds of database time. The same commit
  relabels the SIGKILL fixture around the process-exit state it actually
  observes. Commit `c014502` corrects both evidence ledgers so the unproven
  production handler/provider/queue-ack matrix remains open. At exact head
  `c014502`, 11 focused PostgreSQL scenarios, three fresh PostgreSQL/Redis
  transport scenarios, and repository-wide `pnpm check` pass. Independent
  fixed-head Spec and Standards reviews report no blocker/high merge finding.
- Commit `9d1fc7d` passes the immutable preview retention deadline into the
  node-attempt artifact capability. Preview artifacts are capped at that
  deadline, and an already-expired owner is rejected before persistence.
  Commit `685ff8e` adds forced-RLS `artifact_links`, composite ownership
  constraints, and a PostgreSQL trigger that prevents an artifact from
  outliving its preview. Pending artifact metadata and its ownership link are
  created atomically; serving roles receive no arbitrary link deletion grant.
- Commit `d71564e` adds the durable `sweep-expired-previews` lifecycle only
  after its full capability exists. Acceptance schedules a delayed cleanup
  outbox row at the preview deadline. The worker validates the checksum-bound
  delivery, claims owned artifacts in configurable batches, resumes `deleting`
  rows after failure, removes object bytes before marking metadata deleted,
  emits continuation deliveries while work remains, and calls the narrow
  tenant-checked security-definer function only when final deletion is safe.
  A real PostgreSQL/Redis/BullMQ/S3Mock scenario creates an artifact through
  the production preview capability and proves both object and metadata
  cleanup. The focused fresh-PostgreSQL preview suite passes 14 scenarios, the
  real transport file passes four, all 112 worker unit assertions pass, and
  repository-wide `pnpm check` is green at that implementation checkpoint.
  The first fixed-head review nevertheless found that this implementation used
  competing consumers on one maintenance queue and could delete a `pending`
  artifact while its upload remained ambiguous; `37a867f` is the mandatory
  correction below, so `d71564e` is not valid in isolation.
- Commit `a3a03d8` proves the migration path that fresh-schema tests cannot:
  it creates a retained preview on exact migration head `0023`, applies only
  `0024_preview_retention_cleanup.sql`, and verifies the backfilled payload,
  trace context, application-canonical checksum, and exact expiry-timed
  availability through the worker's forced-RLS view. This closes the focused
  prior-head backfill risk without claiming the broader Phase 4 migration or
  activation gates complete.
- Commit `37a867f` resolves both high findings from the first artifact-
  retention reviews. Production now owns exactly one maintenance consumer that
  routes reconciliation and cleanup, so valid jobs cannot be stolen and
  rejected by competing BullMQ workers. Cleanup refuses nonterminal previews,
  durably moves artifacts into `deleting`, waits longer than the configured
  artifact-store request timeout, then requires both deletion and a confirming
  `HEAD` miss before metadata can become `deleted`; the preview owner remains
  until that sequence finishes. Bucket readiness is checked before the
  consumer starts. Migration `0025_preview_cleanup_idempotency.sql` retires the
  expired preview acceptance record with its run, allowing the key to be used
  safely after retention. The prior-head proof now applies `0024` and `0025`.
  Verification passes root `pnpm check` with 114 worker assertions, 16 focused
  fresh-PostgreSQL scenarios, and four real
  PostgreSQL/Redis/BullMQ/S3Mock transport scenarios in 13.36 seconds. Phase 4
  remains open for the independently listed crash, telemetry, and HTTP gates.
- The next Standards review correctly kept merge blocked: a `HEAD` that still
  observed bytes after deletion was classified as unrecoverable, and the
  privileged final-delete function trusted the adapter's terminal guard.
  Commit `72d5bd5` makes absence-confirmation failure call the durable finish
  seam, which leaves metadata open, completes the current inbox receipt, and
  schedules a successor cleanup delivery. Its two-attempt regression observes
  the object first, then confirms absence and completes metadata on retry.
  Migration `0026_preview_cleanup_terminal_guard.sql` independently locks and
  validates terminal preview state inside the security-definer boundary; a
  direct worker-role call against an expired queued preview returns false and
  preserves both run and artifact. Root `pnpm check`, 16 focused PostgreSQL
  scenarios, and four real PostgreSQL/Redis/BullMQ/S3Mock scenarios in 13.35
  seconds pass at this correction. Independent Spec and Standards reviews
  against exact head `9ae51d51f8bbdc8726350e26ac2db534da3eae24`
  report no blocker/high merge finding. Spec reports no finding at any
  severity; Standards' one low note observes that the handler retry unit mocks
  the finish seam, while the separate real-PostgreSQL test proves successor
  creation and consumption. This artifact-retention checkpoint is merge-safe;
  Phase 4 remains incomplete.
- At corrected documentation head `d3f1397`, root `pnpm check` passes all
  format, ESLint, generated-contract, typecheck, unit, and production-build
  gates. The dependency-ordered fresh real-service matrix passes against
  PostgreSQL 18 migrated zero-to-`0022_preview_execution.sql`: artifact-store
  2 in 0.269 s, database 230 across 16 files in 16.86 s, worker 11 across four
  files in 4.48 s, and API 7 across two active files in 6.37 s. The additive
  compatibility-rollout proof runs last and passes one assertion in 1.35 s.
  The disposable database is dropped afterward; PostgreSQL, Redis 8.2.8, and
  S3Mock 5.1.0 remain healthy. This verifies the repair branch but does not
  close the unchecked Phase 4 activation criteria above.
- Commit `40c35bf` adds migration head
  `0027_preview_terminal_facts.sql` and closes the durable terminal-facts
  portion of ADR 016. Every first terminal completion—ordinary worker outcome,
  expired-attempt reconciliation, or durable reconciliation delivery—appends
  one safe `preview.execution_terminal` audit event and one idempotent
  `preview_execution` usage charge in the same PostgreSQL transaction as the
  attempt/run transition. Exact redelivery returns before either insert, and a
  forced usage-key collision proves the transition plus its preceding audit
  insert roll back together. The usage table is forced-RLS, append-only for
  serving roles, tenant scoped, period indexed, and uniquely keyed per preview;
  readiness verifies its schema, policies, worker audit/usage insert authority,
  and withheld mutation grants. The migration backfills safe audit and usage
  facts for previews already terminal at head `0026`, restoring FORCE RLS
  before commit. Tests assert actor/trace correlation, pinned identity and
  disclosure metadata, absence of input/output bodies, one fact across exact
  redelivery, and `outcome_unknown` reconciliation facts. Root `pnpm check`
  passes; 28 focused fresh-PostgreSQL scenarios pass across connection upgrade,
  preview worker, and prior-head migration files. The complete shared-database
  integration command could not provide valid evidence because the existing
  local `pertexo` database records a different checksum for immutable migration
  `0012_workflow_authoring.sql`; that potentially user-owned database was not
  reset. At that checkpoint, terminal runtime metrics and the remaining Phase 4
  gates stayed open.
- Commit `3802ec8` closes the terminal runtime-metrics gap without turning
  OpenTelemetry into an authority. `pertexo.preview.terminal.count` increments
  only after the database reports the first committed terminal transition and
  classifies it by bounded outcome/source, side-effect class, provider-contact,
  external-effect, dispatch, and connection-use booleans. Exact duplicate
  execution claims do not increment it. Durable reconciliation emits the
  separate `pertexo.preview.reconciliation.count` decision counter, including
  bounded `duplicate`, `rescheduled`, `redelivered`, and terminal decisions;
  only a committed reconciliation also emits a terminal count. No workspace,
  workflow, run, node, user, URL, connection identifier, or arbitrary provider
  value is a metric attribute. Metric failures are isolated after durable
  commit and cannot fabricate a retry or change outcome truth. Production
  execution and maintenance composition both receive the instruments. Root
  `pnpm check` passes with 117 worker assertions, including direct committed,
  duplicate, reconciliation, attribute-cardinality, and collector-failure
  proofs. The remaining Phase 4 failure and full-regression gates stay open.
- Commits `29ad6c8`, `eb038d1`, and `ce31443` resolve the fixed-head terminal-
  facts and metrics review findings without rewriting migration `0027` or its
  immutable historical facts. Additive head
  `0028_preview_terminal_fact_corrections.sql` pins request/trace and bounded
  provider/operation identity, backfills available acceptance correlation,
  extends the immutable-pin trigger, and enforces UUIDv7 for new preview audit
  and usage facts while preview acceptance, reconciliation, and cleanup now
  generate application UUIDv7 identities. Terminal audit metadata includes the
  complete dry-run/side-effect disclosure; execution and reconciliation metrics
  include bounded provider/operation classification. Readiness now attests the
  exact usage columns, defaults, constraints, indexes, policies, grants, new
  preview columns, UUID checks, trigger, and complete trigger-function body and
  catalog configuration. Tests prove same-name FK drift and a no-op trigger
  replacement fail readiness, pin mutation fails, and terminal facts are
  invisible under another workspace context. Root `pnpm check` passes at
  `eb038d1`; the final timestamp-default correction at `ce31443` separately
  passes database formatting, ESLint, typecheck, 57 unit assertions, and build.
  Twenty focused fresh-PostgreSQL scenarios pass across preview execution and
  prior-head migration. Independent final Spec and Standards reviews of exact
  head `ce31443` report no blocker, high, or medium finding. Phase 4 remains
  open for the already listed failure and full-regression gates.
- The next preview failure audit found the prior-preview input requirement only
  partially evidenced. The real PostgreSQL acceptance fixture now proves that
  only a successful, still-unexpired source from the same workspace and exact
  workflow can be copied: cross-workspace, same-workspace/different-workflow,
  failed, and expired sources all return the stable unavailable outcome. The
  fixture also scopes its identifier-only outbox assertion to the execution job
  now that acceptance independently schedules retention cleanup. All eight
  scenarios pass on a disposable PostgreSQL 18 database migrated zero-to-head
  in 1.49 seconds, and the database is dropped afterward. The aggregate preview
  failure box remains open for direct use-case authorization denials and the
  full production-handler process-crash matrix.
- The direct node-test authorization checkpoint closes the first of those two
  gaps. `TestWorkflowNodeUseCase` now authorizes every referenced connection
  independently before either `validate` or `test_execute` can return or accept
  durable work, matching ADR 016 rather than allowing validation to bypass
  `connection:use`. Tests prove missing `workflow:update` fails before draft
  access and independently prove missing `connection:use` fails after bounded
  validation but before preview acceptance in both modes. All 222 API unit
  assertions, API typecheck/build, focused formatting, and ESLint pass. The
  aggregate preview failure box remains open only for the composed production-
  handler process-crash matrix.
- The composed process-crash checkpoint closes the remaining preview failure
  matrix. Four child workers execute through the production node-attempt
  BullMQ consumer and stop at the exact ADR 007 boundaries before dispatch-
  marker commit, after marker commit before provider effect, after provider
  effect before outcome commit, and after outcome commit before queue
  acknowledgement. Parent assertions observe each real job as active, preserve
  independently committed provider-effect cardinality, and prove marker,
  output, inbox, audit, usage, and fence truth. A production maintenance
  consumer reclaims undispatched work and resolves unsafe marked work to
  `outcome_unknown`; a fresh production attempt consumer then performs real
  BullMQ stalled redelivery of the committed terminal job without invoking the
  provider or changing terminal facts. Queue cleanup prevents killed jobs from
  leaking between runs. The fresh zero-to-head PostgreSQL/Redis suite passes
  four enabled scenarios with one artifact-store scenario intentionally skipped
  in 69.11 seconds; worker typecheck, focused ESLint, and formatting pass, and
  independent review reports no medium-or-higher finding.
- No Phase 4 registry release or publishable node capability is claimed
  complete yet. The managed connection API includes its SSRF-enforcing test
  endpoint and a staged generic HTTP executor candidate now exists, while
  production composition, artifact streaming, integration-usage projection,
  compatibility rollout, and preview execution remain gated.
- Commit `6b1a6b6` adds the server-only, policy-enforcing HTTP execution
  boundary. Its single client seam validates a strict bounded request, resolves
  and rejects every non-public or mixed DNS answer, pins the selected address
  into the Node HTTP/TLS lookup, re-resolves every bounded redirect, rejects
  HTTPS downgrade and unsafe method rewriting, and performs exactly one
  transport call per accepted hop. One total abortable deadline spans DNS,
  dispatch evidence, redirects, transport, and response streaming. Response
  headers and bytes are bounded and allowlisted, credential values are redacted
  from textual and binary bodies, and encoded bodies that cannot be inspected
  are rejected. Errors retain only a stable safe code, definite/ambiguous
  classification, and possible-dispatch fact—never adapter causes. The closed
  ADR 007 matrix retries pre-dispatch work safely, reuses provider keys for
  `idempotent_with_key`, and makes unsafe ambiguous transport/provider outcomes
  `outcome_unknown`. Sixty-five typechecked assertions cover IPv4/IPv6 ranges,
  literal/private/mixed DNS, rebinding-resistant lookup, redirect hops and
  downgrade, header/body/timeout/response limits, binary redaction, compression,
  cancellation, error truth, all three side-effect classes, and a real local
  Node transport pin; package lint and build pass.
- Commit `2bc4ad7` completes the managed connection test endpoint through that
  boundary. Its strict HTTPS-only request and secret-free result are present in
  generated OpenAPI/client artifacts; the guarded API requires `connection:use`,
  CSRF, and request idempotency. A tenant-scoped durable claim returns exact
  completed replays without KMS or network access, rejects conflicting or
  concurrent keys, and records a dispatch audit fact before I/O. Membership,
  connection status, provider identity, claim ownership, and the current secret
  pointer are rechecked immediately before decryption and again before dispatch.
  Revocation/rotation races therefore stop dispatch, while a rotation after
  dispatch prevents an old credential result from changing the new secret's
  health. Only bounded status/error metadata is persisted or returned; provider
  bodies and decrypted bytes are cleared, and credential-bearing redirects may
  not change origin. Verification passes 207 API assertions including the real
  Nest/Fastify guard-controller stack, 10 contract assertions plus generated
  artifact drift, 66 integration-package assertions, 56 database unit
  assertions, and nine fresh PostgreSQL 18 connection assertions. Focused
  typechecks/builds and ESLint for every changed source/test path pass.
- Commit `d0449aa` adds executor ABI 2 and a narrow dispatch-aware worker
  runtime. It carries only pinned attempt identity, opaque connection
  references, optional connection/artifact capabilities, side-effect policy,
  and a single `beforeDispatch` operation. ABI 2 execution fails closed when
  runtime evidence is absent, duplicated, or never committed; unknown future
  ABIs are rejected instead of silently inheriting ABI 1 dispatch behavior.
  Worker tests prove the order executor start → durable dispatch marker →
  provider I/O, while ABI 1 retains the Phase 3 pre-execution behavior.
  Verification passes 22 Node SDK, 81 workflow-engine, 14 core-node, and 68
  worker assertions; all four packages typecheck and build, and focused
  formatting and ESLint pass.
- Commit `99ae053` adds the browser-safe `http.request@1` manifest and strict
  schemas separately from its server-only staged executor. The manifest pins
  exact definition/executor ABI 2 identity, unsafe retry class, I/O resource
  class, connection requirements, capabilities, and network/value policies but
  is absent from the exact production core release. The executor requires an
  HTTPS target and one opaque HTTP-header connection, resolves credentials only
  through the worker runtime immediately before dispatch, rejects configured
  credential/hop-by-hop headers and case-insensitive collisions, commits the
  dispatch marker through the secure HTTP boundary, clears mutable secret/body
  bytes, returns bounded inline values or an artifact reference, and collapses
  unexpected adapter/storage causes into safe truthful outcomes. An isolated
  release proves exact ABI compatibility without changing production catalogs.
  Verification passes 75 integration-package assertions, 10 contract
  assertions plus generated-artifact drift, and all 207 API assertions; affected
  packages typecheck/build and every changed source/test path passes ESLint.
  At that checkpoint, this evidence did not yet claim streaming artifact
  persistence or production connection/artifact capability composition. Usage
  projection, additive rollout, and preview completion remain incomplete.
- Commit `46450d9` replaces the candidate's buffered large-response handoff
  with a bounded streaming body consumer. The secure HTTP boundary enforces its
  total deadline and raw/redacted byte limit while redacting credential values
  across arbitrary chunk boundaries, closes transport responses on consumer
  success/failure, and preserves safe sink failures without exposing adapter
  causes. Small response streams become exact UTF-8/base64 inline values;
  larger streams pass directly to the invocation artifact capability. The
  executor now requires and invokes a current-secret assertion before its
  durable dispatch marker, so rotation/revocation between decrypt and dispatch
  prevents provider I/O. Verification passes 77 integration assertions and 22
  Node SDK assertions with affected typechecks, builds, and ESLint green.
- Commit `7c223ab` composes invocation-scoped worker connection and artifact
  factories from production configuration. Connection resolution is bound to
  the lease workspace/worker, decrypts through the managed-KMS adapter, and
  rechecks workspace, status, provider, auth type, and exact current secret
  immediately before dispatch. Artifact output is hard-bounded while streaming
  to a mode-0600 temporary spool, creates pending tenant-scoped metadata before
  upload, verifies the object-store result, finalizes metadata only afterward,
  clears mutable chunks, removes the spool on every path, and closes owned DB,
  KMS, and store resources. Verification passes 75 worker assertions, 56
  database unit assertions, nine fresh PostgreSQL 18 connection assertions,
  and two PostgreSQL/Redis/S3-compatible artifact-reference assertions. All
  affected packages typecheck/build and focused ESLint passes. The HTTP node is
  still excluded from production catalogs pending the usage projection,
  canonical downstream artifact resolution, compatibility rollout, telemetry,
  and preview gates.
- Commit `23e3a0a` advances the migration head to
  `0021_workflow_integration_usage.sql` and adds the disposable, forced-RLS
  `workflow_integration_usage` projection. Stable provider/operation metadata
  is fingerprinted in node releases but excluded from fallback definition
  compatibility identity; required connection slots are projected recursively
  from the retained immutable `graph_json`. Publication deletes and rebuilds
  the exact rows inside its existing version/pointer/outbox/audit/idempotency
  transaction, including when a presentation-only change reuses a version.
  The API role alone can select/insert/delete derived rows, while worker and
  dispatcher roles have no access; execution continues to consume only the
  immutable workflow version. Covering provider/operation and connection
  indexes back bounded cursor queries for impact and revocation analysis.
  Fresh PostgreSQL 18 verification passes 17 authoring/RLS/rollback scenarios
  and nine clean-install plus supported `0020`-to-`0021` migration/connection
  scenarios, including cross-workspace isolation and projection restoration
  from the retained graph. Unit suites pass 23 Node SDK, 52 workflow-model, 77
  integration, 57 database, and 207 API assertions; affected packages build,
  typecheck, lint, and format-check cleanly. The PostgreSQL schema/index review
  shaped the composite tenant-first covering indexes and bounded keyset query
  interfaces. At that checkpoint, HTTP release, canonical downstream artifact
  resolution, telemetry, and preview gates remained incomplete.
- Commit `6061f48` adds the browser-safe `@pertexo/node-catalog` and composes
  the already implemented HTTP manifest/executor additively through two exact
  rolling cohorts: epoch 2→3 introduces HTTP with a staged executor, and epoch
  3→4 activates it. API and worker configuration defaults to the unchanged
  `core` cohort; staging workers continue serving the epoch-2 registry, and an
  activation node-attempt worker fails closed before adapter creation unless
  both just-in-time connection and artifact capabilities are present. API
  authoring, run admission, worker coordinator/node execution, and readiness
  all receive the selected cohort explicitly. Verification passes four catalog,
  14 core-node, 207 API, and 77 worker assertions, all affected typechecks, and
  focused formatting/ESLint. This establishes an explicit deployment artifact
  path without silently making HTTP part of the default production cohort.
- Commit `8deeee8` separates the at-most-two-release deployment readiness
  overlap from retained immutable execution history. The engine validates every
  contiguous historical successor and resolves only exact epoch/fingerprint
  identities; authoring selects its current compiler/catalog through the
  bounded readiness pair while retaining older variants, and API/worker
  execution verifies old envelopes against the full history. A fresh disposable
  PostgreSQL 18 database migrated from zero through
  `0021_workflow_integration_usage.sql` passes the exact epoch 1→2→3→4 rollout:
  both API and worker target probes precede each activation, old cohorts fail
  readiness at the next boundary, staged HTTP placement is rejected, active
  HTTP publishes with one exact provider/operation/connection usage row, and a
  workflow published under epoch 2 starts successfully after epoch 4. The final
  database state contained epoch 4, one usage row, and one retained-workflow run;
  the disposable database was dropped. Unit verification passes 57 database,
  82 workflow-engine, four catalog, 207 API, and 77 worker assertions plus all
  affected typechecks and focused lint/format checks. HTTP activation remains
  explicitly selected rather than default and is not yet a Phase 4 release
  claim: canonical downstream persisted-value consumption, provider telemetry,
  preview execution, regression/recovery gates, and completion reviews remain
  open.
- Commit `d115918` closes the canonical downstream-value gap with a real
  PostgreSQL coordinator/run-store proof. A completed node persists an
  HTTP-shaped structured output whose body is an artifact reference into both
  attempt and node rows. The fixture then mutates the original in-memory output,
  admits and claims a distinct downstream attempt, and proves `loadInputs`
  returns the original persisted artifact ID and metadata rather than the
  transient object. This composes with the existing HTTP executor inline-vs-
  streaming threshold assertions and the real PostgreSQL/S3-compatible worker
  artifact proof, where metadata is available only after verified upload and
  finalization. All 29 coordinator/run-store integration scenarios and the
  database test typecheck pass; the disposable database is removed by the
  suite.
- Commit `4a496a8` wires bounded HTTP provider telemetry through the active
  catalog and production node-attempt registry. Every request receives one
  `pertexo.provider.http.request` span, request count/duration metrics, fixed
  provider/operation/outcome/error/dispatch/storage/status-class attributes,
  and a dedicated rate-limit counter. URLs, hostnames, connection/workflow/run
  IDs, credentials, and arbitrary provider values are never attributes.
  Diagnostics preserve provider truth when tracing or recording fails. The
  active-registry proof executes HTTP through the telemetry seam, while worker
  tests verify success, artifact storage, safe failure/rate-limit classes,
  fixed-cardinality production attributes, span closure, and diagnostic
  failure isolation. Verification passes 77 integration, five catalog, and 80
  worker assertions; all three packages build/typecheck and focused
  format/ESLint checks pass. Remaining Phase 4 gates are the unchecked
  connection/ADR-007 failure proofs, final activation assertion, durable
  validate/test-execute preview slice, full recovery/regression matrix, and
  independent completion reviews.
- Commit `ef72b01` establishes the browser-safe and transport contract
  foundation for ADR 016 without claiming executable preview behavior. The
  public node-test request is a strict `validate`/`test_execute` discriminated
  union: both modes pin a positive draft revision, execution accepts only
  bounded manual JSON or one opaque prior-preview identity, and the literal
  side-effect acknowledgement cannot be omitted or set false. The documented
  endpoint makes idempotency conditional on execution, returns a bounded
  field-addressed validation report at `200` or an immutable preview summary at
  `202`, and exposes a separate workspace-scoped status resource with only
  bounded inline JSON or an artifact identity. Deterministic client/OpenAPI
  artifacts and a deliberate browser package export are committed. The new
  `execute-preview-attempt` transport contract shares the node-attempt pool but
  carries only workspace, preview-run, preview-attempt, outbox, and trace
  identifiers; its queue/metric routing is compile-time exhaustive. Verification
  passes 13 contract, 35 queue, and 32 observability assertions, generated-
  artifact drift checks, all workspace typechecks, affected builds, and focused
  ESLint. Persistence, API authorization/validation, worker execution, and the
  preview failure matrix were still open at this checkpoint.
- Commit `ca7ea19` advances the clean migration head to
  `0022_preview_execution.sql` and adds forced-RLS `preview_runs` plus exactly
  one `preview_attempt` per accepted execution, wholly separate from workflow
  versions, production runs, checkpoints, and run events. The immutable run
  identity pins the workspace/workflow/draft revision and fingerprint, node
  snapshot, definition/executor and exact compatibility release, actor,
  idempotency/request hashes, canonical bounded input, optional prior preview,
  disclosure, trace context, and at-most-24-hour retention deadline. The API
  role can accept and read but cannot mutate pins; the worker can read and
  update only execution-state columns and cannot insert attempts or alter the
  provider idempotency key. Acceptance locks the exact current draft, rechecks
  an active builder-or-stronger membership, copies only a successful unexpired
  prior output from the same tenant/workflow, and atomically commits the run,
  attempt, idempotency result, safe audit fact, and identifier-only outbox job.
  Exact replays survive later draft edits; conflicting replays, stale revisions,
  cross-workspace references, and transaction rollback fail without partial
  facts. A fresh PostgreSQL 18 database migrates zero-to-`0022`; seven focused
  preview scenarios and the complete 14-file/216-assertion database integration
  matrix pass, alongside 57 database unit assertions, all workspace typechecks,
  the database build, and focused ESLint. The final focused proof contained one
  preview run, one attempt, and one preview outbox row before the disposable
  database was dropped. Worker execution, cleanup, and crash/outcome proofs
  remain open; API behavior is evidenced by the later `c06e3d4` checkpoint.
- Commit `2edc729` adds the pure validation half of ADR 016 behind a deliberately
  non-executable server-only catalog seam. The resolver selects one exact node
  definition from one pinned compatibility release and exposes its manifest and
  schemas without constructing an executor or possessing credential, DNS,
  provider, queue, or artifact capabilities. API validation resolves the same
  literal/run-input/expression mappings used by runtime against bounded sample
  input, parses configuration and resolved input through the exact schemas,
  checks declared opaque connection slots, derives the side-effect disclosure
  from immutable manifest metadata, and caps stable field-addressed issues at
  100. Missing/ambiguous nodes and definitions unavailable in the pinned release
  fail closed. Six catalog assertions and the full 44-file/210-assertion API
  suite pass with affected builds, typechecks, formatting, and ESLint. Endpoint
  composition, stale-revision handling, connection-use authorization, durable
  execution acceptance, and status reads are evidenced by the later `c06e3d4`
  checkpoint.
- Commit `c06e3d4` adds the application and HTTP boundary for pure validation,
  durable test execution acceptance, and scoped preview status reads. The POST
  route enforces the exact draft revision, conditional `Idempotency-Key`,
  literal side-effect acknowledgement, `workflow:update`, and `connection:use`
  whenever the selected node references a connection. It validates manual input
  with the runtime-shared mapping resolver, defers prior-preview input mapping
  until the worker reads the persisted canonical copy, pins the exact registry
  release and executable node snapshot, and returns `200` without persistence
  for validation or `202` only after atomic acceptance. The GET route rechecks
  active builder-or-stronger access, relies on forced RLS, hides expired and
  cross-workspace previews, and returns only the bounded public status shape.
  Nest registers these routes only when both preview persistence and an exact
  registry release are supplied; production composition remains deliberately
  gated until the preview worker is ready. Verification passes 57 database unit
  assertions, 219 API assertions, both package typechecks/builds, focused
  ESLint, and eight preview integration scenarios on a fresh PostgreSQL 18
  database migrated zero-to-`0022`; the disposable database was removed. The
  remaining preview gates are worker dispatch/execution, output/artifact
  completion, duplicate/crash/timeout/ambiguity proofs, and retention cleanup.
- The retained Phase 3 execution proof now runs in the worker integration suite
  against a disposable PostgreSQL database migrated from zero through `0028`
  and real Redis transport. It activates the exact epoch 1→2→3→4 sequence only
  after API and worker readiness probes, preactivation records, and approval,
  then loads the checked-in immutable epoch-2 executable/checksum fixture and
  executes its Manual→Set/Map→Terminate workflow through
  the production coordinator and node-attempt runtimes of the
  `http_activation` artifact. The run reaches `succeeded` at checkpoint revision
  4 with the complete terminal checkpoint, all three node/attempt statuses and
  canonical outputs, and all 12 ordered run events asserted exactly. Persisted
  release facts remain pinned to epoch 2 while the active pointer is epoch 4;
  bounded connection and artifact factories satisfy activation capability
  requirements, but their provider-facing methods receive zero calls; the
  production epoch-4 registry's HTTP transport is also instrumented and receives
  zero calls. The focused real PostgreSQL/Redis suite passes all three
  coordinator scenarios and
  drops its disposable database afterward. This closes the retained-old-version
  happy-path item; the fixed-head rollout and regression evidence follows.
- Fixed implementation head `abb6ef32d7c70021cefdf79c06ef13ede64a30a4`
  passes the Phase 4 completion matrix with Node.js 24.15.0, pnpm 11.22.0,
  PostgreSQL 18.6, Redis 8.2.8, BullMQ 6.1.2, and S3Mock 5.1.0. Root
  `/usr/bin/time -p pnpm check` passes formatting, ESLint, generated-contract
  drift, all workspace typechecks and unit suites (including 222 API and 117
  worker assertions), and all production builds in 40.91 seconds. A dedicated
  disposable database migrates zero-to-head through
  `0029_provider_idempotency_key_invariants.sql`; the supported prior-head
  connection and preview-retention upgrade suites pass 12 assertions.
- With the documented CI service environment, sequential package commands use
  `vitest run --config vitest.integration.config.ts --no-file-parallelism`.
  Artifact-store passes 2 assertions in 0.225 seconds, database passes 245
  across 17 files in 21.17 seconds, worker passes 16 across five files in 85.88
  seconds, and API passes 7 active assertions in 7.13 seconds. The separate
  `PHASE0E_EXECUTION_INTEGRATION=true pnpm --filter @pertexo/worker test:phase0e`
  passes five crash/restart/cancellation assertions in 41.53 seconds;
  `API_SSE_RESILIENCE_INTEGRATION=true pnpm --filter @pertexo/api
  test:sse-resilience` passes Redis-loss reconstruction in 7.31 seconds;
  `WORKER_TRANSPORT_RESILIENCE=true pnpm --filter @pertexo/worker
  test:resilience` passes sequential Redis/PostgreSQL loss and drain in 16.45
  seconds; and `API_COMPATIBILITY_ROLLOUT_INTEGRATION=true pnpm --filter
  @pertexo/api test:compatibility-rollout` passes the additive cohort assertion
  in 1.30 seconds.
- The matrix exposed a real role-awareness defect in preview-artifact readiness:
  dispatcher readiness incorrectly required membership and privileges on the
  API/worker artifact policy. Commit `abb6ef3` corrects the catalog check; its
  targeted 17-assertion regression and the complete 245-assertion sequential
  database matrix pass. After the recovery injections, PostgreSQL reports
  ready, Redis returns `PONG`, and all three Compose dependencies report healthy.
  The disposable gate and all test-prefixed databases left by aborted attempts
  were removed. The user-owned shared `pertexo` database was not reset because
  it retains the previously documented historical `0012` checksum mismatch.
- Independent fixed-head reviews of `67474b3...abb6ef3` returned NO-GO. The
  Spec review found that production API composition omitted preview persistence
  and release dependencies, so node-test routes were not registered. The
  Standards review found that unsafe possibly dispatched cancellation/timeout
  could become a definite control outcome, preview HTTP cancellation shared the
  same defect, and provider-confirmed HTTP success could be replaced by an
  artifact-persistence failure. The review gates remain open while those
  findings receive regression fixes and a new fixed-head review.
- The corrected fixed implementation head `fc7e028` received independent Spec
  GO: production composition registers both node-test modes and preview status,
  and the reviewed terminal corrections satisfy the Phase 4 contract. The
  independent Standards review remained NO-GO: typed executor retries were
  collapsed into `attempt_invalid`, post-response inline stream failures could
  replace provider-confirmed truth with definite failure, preview classification
  trusted a provider adapter's cancellation decision without applying unsafe
  lease context, and executor ambiguity still crossed packages through an
  unowned structural convention. The fixed-head review gate remains open until
  those findings are regression-tested and Standards is rerun.
- Commit `efe46e2` resolves the provider-confirmed inline-stream finding. Three
  failing-first regressions showed that a 2xx response followed by body timeout,
  cancellation, or network stream failure had been classified as definite;
  those post-response failures are now ambiguous and unsafe HTTP execution
  preserves `outcome_unknown`. The focused secure HTTP and HTTP Request suites
  pass 65 assertions, with integrations typecheck and scoped lint green.
- Commit `7f16f9a` replaces ad hoc executor-error shapes with the finite
  server-only `NodeExecutorFailure` taxonomy and keeps adapter retry output as
  evidence rather than a decision. Migration
  `0030_coordinator_retry_decisions.sql` stores a complete pending executor
  failure tuple on the terminal attempt while the node remains nonterminal. The
  coordinator resolves the pinned `engine.retry@1` maximum-attempt/error policy,
  deterministic bounded jitter, and exact PostgreSQL due time, then atomically
  commits `node.retry_scheduled` or a truthful terminal result. The worker never
  sleeps, calculates backoff, or treats BullMQ delivery as a business retry.
- Failing-first tests covered typed retry propagation, generic unsafe preview
  cancellation, malformed taxonomy values, pending attempt persistence,
  deterministic/capped jitter, definite cancellation, and coordinator retry
  commit. Focused suites pass 24 Node SDK, 80 integrations, 90 engine, 59
  database unit, 125 worker, and 31 coordinator PostgreSQL assertions. Root
  `pnpm check` passes. A complete sequential database matrix against disposable
  `pertexo_gate_0030` passes all 246 assertions across 17 files, including
  zero-to-head migration, readiness, RLS, and due admission; the gate database
  was removed afterward. The user-owned shared `pertexo` database remains
  untouched with its documented historical `0012` checksum mismatch.
- Independent fixed-head reviews of `67474b3...7f16f9a` remained NO-GO. Spec
  found that persisted `retry_due_at` work had no production PostgreSQL scanner
  to wake the coordinator and that the public node-test route omitted the
  required `/draft` segment. Standards found that adapter retry recommendations
  bypassed the pinned error-kind allowlist and that a generic preview
  cancellation could remain definite after the handler had recorded dispatch
  of unsafe work. The reviews otherwise verified production preview
  composition, response-stream truth, the finite SDK failure protocol,
  deterministic bounded backoff, pending-evidence persistence, atomic
  coordinator resolution, provider-key reuse, and worker/BullMQ non-ownership
  of business retries.
- Commits `e94714b` and `ba539cb` close three of those four findings. Executor
  retry recommendations are now gated by `engine.retry@1`; unsafe dispatched
  preview cancellation becomes `outcome_unknown`; and the generated contract,
  controller, and production route test use
  `/workflows/:workflowId/draft/nodes/:nodeId/test`. The focused engine, worker,
  contracts, and API suites and typechecks pass.
- Commit `f9eb63b` adds migration `0031_due_node_wakeups.sql`, a bounded
  least-privilege PostgreSQL due-node claim function, canonical identifier-only
  coordinator outbox emission, exact wake-marker lifecycle, readiness checks,
  and the production worker scanner loop. PostgreSQL remains authoritative for
  retry due times; neither worker sleeps nor BullMQ delayed jobs own business
  retry timing.
- Commits `e15be0c` and `cfcfd27` add the real liveness proof requested by the
  fixed-head reviews. Two retrying nodes admit no attempt before due; a restarted
  production `CoordinatorRuntime` polls PostgreSQL and creates two wake-up
  outbox rows without unrelated traffic; the real dispatcher fails both while
  Redis is unavailable, releases them durably, then publishes both after
  recovery through BullMQ; the coordinator admits exactly one next attempt per
  node with the original provider idempotency keys and no duplicate durable
  state. The same database suite migrates an exact populated `0030` head by
  applying only `0031`, then verifies readiness, function ownership,
  `SECURITY DEFINER`, and narrow worker grants.
- Commit `28ae56b` attaches the workflow-authoring lock-race expectations before
  releasing their intentional PostgreSQL locks, preserving the assertions while
  removing a fast-CI unhandled-rejection race. The affected disposable
  PostgreSQL suite passes all 17 assertions.
- Final local verification across the closure commits: root `pnpm check` passes;
  the hardened disposable PostgreSQL matrix passed all 247 assertions before
  the immediate-prior-head case was added; focused coordinator wake-up
  integration passes 4 assertions;
  immediate-head coordinator database integration passes 33 assertions; and
  the full artifact/database/worker/API real-service matrix passes. Disposable
  gate databases were removed, while the shared `pertexo` database and its
  documented historical `0012` checksum mismatch remained untouched.
- GitHub Actions run `32672429505` passed at exact head `28ae56b` in 9m24s,
  including 248 database, 17 worker, 7 API, and 2 artifact-store real-service
  assertions, clean-runner quality gates, Phase 0E recovery, SSE Redis-loss
  recovery, sequential service-loss resilience, and additive compatibility
  rollout. Independent Spec and Standards reviews of
  exact range `67474b3...28ae56b` returned GO with no blocker, high, or medium
  findings. Phase 4 is complete.

## Phase 5 — Orchestration slice

Status: **Complete**

Authority and entry gate:

- [x] Complete Phase 4 and preserve its fixed-head Spec/Standards GO before any
      Phase 5 implementation commit.
- [x] Use accepted ADR 008 for structured branches, deterministic joins,
      bounded loops, canonical invocation scopes, and arbitrary-cycle rejection.
- [x] Reuse ADRs 005–007 and 010 for PostgreSQL authority, coordinator/attempt
      separation, cancellation/retry truth, and exact executor compatibility.
- [x] Record ADR 017 before Condition implementation to fix the node contract,
      authoritative port selection, branch reachability/scope, checkpoint V2,
      and pre-Merge reconvergence rejection not specified by ADR 008.
- [x] Record ADR 018 before Switch implementation to fix bounded scalar
      matching, ordered first-match behavior, stable case ports, and reuse of
      the authoritative checkpoint V2 branch-selection path.
- [x] Record ADR 019 before Parallel/Merge implementation to fix bounded fan-out,
      structured pairing, complete-ledger settlement, admission limits, and
      canonical Merge scope.
- [x] Record ADR 020 before For Each implementation to fix the node/body
      contract, explicit structured input, full-budget reservation, nested
      invocation scope, result handling, and recovery semantics.
- [x] Record ADR 021 before Wait implementation to fix its bounded relative
      duration, database clock, delay/admission identity, immutable resume
      attempt, deadline wakeup, preview behavior, and recovery semantics.
- [x] Record ADR 022 before failure-notification implementation to keep terminal
      run truth separate from bounded channel-neutral delivery intent and to
      prohibit secret/provider-body leakage and recursive notification.

Current evidence:

- Commit `5b7ca81` begins Condition through the public node-definition and exact
  release-execution seams. `core.condition@1` has strict `{}` config,
  `{ condition: boolean }` input, `{ selectedPort: "true" | "false" }` output,
  `logic` family, `cpu` resource class, `safe` retry class, and exact `in`,
  `true`, and `false` ports. The executor performs no expression evaluation or
  coercion. Additive staged/active releases are retained in compatibility
  history, but no serving cohort includes them, so Condition is not yet
  placeable, publishable, or admitted. Node catalog tests pass 7 assertions;
  nodes-core and node-catalog build/typecheck plus scoped ESLint pass.
- Commit `ce5bfde` retains edge source/target ports during publication
  validation and rejects invalid Condition ports plus true/false reconvergence
  before Merge exists. Commit `a19df76` adds the bounded checkpoint V2 codec,
  canonical immutable branch selections, and strict V1 preservation.
- Commit `71f6858` retains ports and pinned definitions in scheduler
  projections, validates selections against exact `core.condition@1`, appends
  stable branch scope to invocation identity, derives selected readiness and
  explicit non-selected skips, persists both dispositions in checkpoint V2,
  and creates no attempt for skipped work. The workflow-engine suite passes 98
  assertions and the worker test project typechecks. Database CAS,
  authoritative output loading, worker integration, and recovery proofs remain
  required before the Condition checklist or serving status can change.
- Commit `fa93143` makes the production coordinator checkpoint boundary V1/V2
  aware and atomically persists branch-scoped ready/skipped node runs through
  the existing CAS. The real PostgreSQL proof confirms skipped work creates no
  attempt or execute-attempt outbox delivery. Commit `58cf1bf` admits only
  branch-scoped invocation keys that exactly match structured scope rooted in
  pinned `core.condition@1` nodes.
- Commit `7c4f871` loads candidate Condition output material from the persisted
  attempt/node output pair, correlates it with the exact succeeded event,
  validates `{ selectedPort }` only after immutable executable verification,
  and derives the selection without consuming another persisted event. Root
  `pnpm check`, 100 workflow-engine assertions, 131 worker assertions, and
  focused disposable-PostgreSQL loader/CAS proofs pass. Condition remains
  incomplete pending checkpoint V2 initialization for new Condition runs and
  duplicate/crash/Redis-loss/fresh-worker proofs.
- Commit `3ad8654` verifies every recovered physical node-run branch context
  against its checkpoint V2 invocation scope. Its disposable-PostgreSQL proof
  reloads selected/skipped branch rows successfully, then confirms scope
  corruption fails closed.
- Commit `ad6e52e` carries the persisted branch path into the attempt lease and
  verifies the exact scoped invocation identity before executor dispatch. Root
  attempts retain their existing identity, malformed physical branch context
  fails closed, and engine/worker tests cover the handoff. Commit `bbc687f`
  initializes checkpoint V2 only for verified executables containing
  `core.condition@1`; retained root-only workflows continue to initialize V1.
  Condition remained unavailable pending its recovery and rollout proof.
- Commit `f31a70d` fixes claim-time scope reconstruction for both root `{}` and
  branch-scoped physical contexts; exact-head CI run `32738501737` passes.
  Commit `a38f549` adds bounded Condition staging/activation cohorts and a real
  disposable-PostgreSQL/BullMQ process proof: duplicate Condition attempts are
  inert, Redis queue state is destroyed after the durable result, fresh workers
  reconstruct the selected port from PostgreSQL, one scoped branch executes,
  the other is explicitly skipped without an attempt, duplicate coordinator
  delivery is inert, and checkpoint V2 reaches terminal success. Root
  `pnpm check`, the five-test coordinator consumer integration file, and exact-
  head CI run `32739500260` pass, including Phase 0E crash recovery, Redis and
  service-loss recovery, and additive rollout gates.
- ADR 018 and commits `ace190a`, `483f617`, and `998d230` add the bounded
  `core.switch@1` contract, ordered scalar first-match/default execution,
  configured stable case-port publication validation, generalized durable
  branch selection, checkpoint V2 initialization, and staged/active release
  cohorts. The disposable PostgreSQL/BullMQ matrix runs Condition and Switch
  through duplicate attempt/coordinator delivery, queue destruction,
  fresh-worker recovery, selected scoped execution, explicit unselected skip,
  retained old-release execution, and terminal success. Root `pnpm check`, the
  six-test coordinator consumer integration file, and exact-head CI run
  `32741684377` pass all quality, real-integration, crash, Redis-loss,
  sequential service-loss, and additive rollout gates.
- ADR 019 and commits `58fcc62`, `d729e01`, `116ad3d`, and `33d60af` add the
  bounded `core.parallel@1` and `core.merge@1` contracts, publication-time
  one-to-one topology pairing, stable branch scopes, per-Parallel admission
  limits, complete persisted join ledgers, canonical settlement, and
  checkpoint-derived Merge input. Parallel traversal stops at its paired Merge,
  the Merge invocation removes the branch scope, and production checkpoint and
  node-run stores accept the bounded pending join state without creating an
  attempt before settlement.
- Commit `67ba800` adds Parallel and Merge staging/activation serving cohorts
  only after their paired recovery fixture passes. The disposable
  PostgreSQL/BullMQ proof runs `maxConcurrency: 1`, confirms exactly one branch
  attempt is admitted while both scoped branches remain durable, replays the
  Parallel delivery, destroys both Redis queues, starts fresh workers, settles
  the complete canonical ledger, executes Merge from checkpoint-owned input,
  and reaches terminal success with exactly six attempts. Root `pnpm check`,
  the seven-test coordinator consumer integration file, and exact-head CI run
  `32745784487` pass all quality, real-integration, crash, Redis-loss,
  sequential service-loss, and additive rollout gates.
- ADR 020 fixes the bounded `core.foreach@1` and isolated body contracts before
  implementation: explicit nearest-iteration input, immutable nested scope,
  whole-collection budget reservation before any body admission, bounded active
  iteration concurrency, no implicit result aggregation, and
  PostgreSQL-authoritative cursor recovery.
- Commit `7d12909` adds the strict bounded `core.foreach@1` declaration
  schemas, unchanged-item/count executor, browser-safe manifest, exact server
  registration, and additive staged/active epochs 13 and 14. The releases are
  retained in compatibility history but intentionally absent from every serving
  cohort. Nodes-core passes 18 assertions and node-catalog passes 11 assertions.
- Commit `f46dc17` adds the explicit `structured_input` graph value source,
  validates it against the nearest body boundary, and resolves item/ordinal
  material through the shared mapping seam without redefining outer
  `run_input`. Workflow-model passed 53 assertions at that checkpoint.
- The current For Each checkpoint strengthens publication validation so only
  `core.foreach@1` owns a non-empty isolated body with exact `item`/`ordinal`
  inputs, `result` output, one reachable sink, and no seam-crossing output
  mapping. It independently caps worst-case total iterations and expanded body
  invocations across nested products. Executable V2 now recursively pins,
  canonically orders, checksums, parses, and verifies every body node and applies
  port/branch validation at each depth; compatibility selection includes
  body-only definitions. Workflow-model passes 56 assertions, workflow-engine
  passes 109 assertions, both package builds/typechecks pass, and
  `pnpm contracts:check` reports no public artifact drift. For Each remains
  absent from serving cohorts, confirmed by the 11-assertion node-catalog suite,
  pending scheduling, persistence, and recovery.
- The pure workflow-engine checkpoint replaces the obsolete synthetic
  per-ordinal control attempt with recursively scheduled structured-body node
  invocations. Checkpoint V2 retains exact control, branch, and ordered
  iteration scope; declarations are derived only from matching persisted
  succeeded output material, accept exact inline or artifact references, reserve
  the complete canonical collection before root admission, and fail with
  `loop_limit_exceeded` without partial admission. Exact duplicate declarations
  are inert while conflicts fail closed. Checkpoint V2 now audits remaining
  budget against the initial entitlement and reserved collection sizes, and
  verifies every persisted loop's pinned bounds, roots, sink, and scoped control
  identity against the executable. Empty collections complete immediately,
  non-empty collections hold the control in `waiting`, body dependencies use
  exact scoped upstream invocation descriptors, and attempt execution derives
  nearest `structured_input` item/ordinal only from checksum-verified bounded
  collection material. Body retries, final failures, explicit skips, recursive
  provider keys, canonical concurrent ordinals, completion-order independence,
  cancellation between batches, and nested nearest scope are covered at public
  engine seams. Branch selections are isolated by exact local graph and scoped
  invocation identity. Deadline and cancellation reconcile every active
  ordinal into parser-valid replayable terminal state; the first body terminal
  cause remains authoritative while later ordinals reconcile idempotently.
  Structured state generation rejects checkpoint V1, while retained synthetic
  V1 loops parse and advance through their canonical parent key. Invocation
  iteration scopes are checked against executable ancestry and admitted loop
  ordinals, malformed optional scope fields fail closed, and only declared loop
  controls may wait without a due time. A standalone nested-loop progression
  covers inner declaration/body completion through outer sink/control
  completion. Scoped Merge state uses exact invocation keys where a body
  contains branch/join orchestration. The workflow-engine suite passes 114
  assertions; workflow-model remains green at 56 assertions. This is pure
  engine evidence only: database/worker persistence, crash recovery, Redis-loss
  reconstruction, cancellation recovery, and serving rollout remain pending,
  so the bounded For Each completion box remains open.
- The database-only For Each persistence checkpoint adds migration 0032's
  explicit `for_each_barrier` discriminator, permitting an undated waiting row
  only for that control while preserving timed wait constraints and excluding
  barriers from the due scanner. The Phase 3 checkpoint V2 codec now accepts
  exact branch and iteration scope, scoped joins, bounded loop state, and
  initial-budget accounting while retaining V1 and loop-free V2. Coordinator
  CAS validates whole-collection reservation, immutable loop ownership and body
  root facts, persists/reloads branch plus iteration context, forwards bounded
  declaration output candidates, and makes duplicate declaration commits
  inert. A disposable-PostgreSQL proof covers the first loop CAS, undated
  barrier storage, due-scan exclusion, fresh-store reload, duplicate replay,
  and physical context tamper rejection. Worker/BullMQ recovery, later-batch
  and cancellation recovery, and serving rollout remain pending, so bounded For
  Each remains incomplete and absent from serving cohorts. The database unit
  suite passes 66 assertions, the focused disposable coordinator suite passes
  35 assertions, database build/typecheck and root typecheck pass, and the full
  database integration command's reusable local-database suites remain blocked
  by a pre-existing recorded checksum mismatch for untouched migration 0012.
- The production For Each attempt-input checkpoint recursively resolves body
  nodes from the verified executable, authenticates their branch and complete
  iteration ancestry, and replaces unscoped upstream node IDs with exact
  invocation descriptors. Attempt leases retain non-empty iteration paths;
  PostgreSQL loads only exact succeeded invocation keys and rejects missing,
  duplicate, changed-node, or cross-ordinal material. For scoped attempts it
  reconstructs the nearest enclosing collection from checkpoint ownership and
  the exact persisted declaration node/attempt output pair, verifies inline
  reference ownership, strict `items`/`iterationCount`, collection size and
  checksum, ordinal bounds, every active enclosing loop, and nested branch/
  iteration scope, then passes the engine's structured collection proof.
  Scoped Merge input now resolves only by exact `joinInvocationKey`. Focused
  worker tests pass 141 assertions, database unit tests pass 66 assertions, and
  the disposable real-PostgreSQL coordinator suite passes 36 assertions,
  including same-body-node outputs at ordinals 0 and 1 that cannot cross-read
  and fail-closed checksum, active-ordinal, and collection-reference drift.
  The seven-assertion PostgreSQL/Redis/BullMQ coordinator recovery suite also
  remains green for root execution, Condition, Switch, Parallel/Merge, due
  retries, and replay auditing with exact predecessor scope descriptors.
  The complete reusable-database integration command remains blocked by the
  already recorded checksum mismatch for untouched migration 0012. No For Each
  serving cohort is activated; BullMQ process recovery, later-batch and
  cancellation recovery, Redis-loss reconstruction, and rollout remain.
- The bounded For Each completion checkpoint adds a production
  PostgreSQL/BullMQ fixture with one declaration, a two-node body and canonical
  sink, three exact ordinal scopes, `maxConcurrency: 2`, and one outer
  successor. Separate success and cancellation runs prove exact scoped map/sink
  outputs, the unchanged declaration output consumed by the successor, whole-
  collection budget `1000 -> 997`, cursor `2 -> 3`, no synthetic iteration
  attempts, and no ordinal-2 node run after cancellation between batches. The
  fixture replays the declaration attempt and reservation coordinator delivery,
  terminates and starts genuinely fresh worker child processes, and obliterates
  both BullMQ queues after the declaration outcome, after reservation before
  acknowledgement, after first-batch sink outcomes, and after the next-batch
  checkpoint. PostgreSQL reconstructs the exact active/terminal ordinals and
  admits no duplicate work. This proof exposed and fixes a production CAS
  validator defect that rejected a succeeded body root while its iteration sink
  remained active. Epochs 13 and 14 are now selectable additive For Each
  staging/activation cohorts: staging serves epoch 12, activation serves epoch
  14, and activation retains executable history through all fourteen releases.
  Existing pure engine/model proofs cover exact and over-limit collections,
  worst-case nested expansion, budget exhaustion before admission, completion-
  order independence, nested nearest-scope progression, timeout/retry/failure,
  and cancellation reconciliation. Generated contracts have no drift. Final
  verification passes root `pnpm check` (including 56 workflow-
  model, 114 workflow-engine, 66 database, 11 node-catalog, 145 worker, and 227
  API unit assertions) and the complete eight-assertion disposable PostgreSQL/
  BullMQ coordinator recovery file; its For Each child-process assertion takes
  8.2s.
- ADRs 021 and 022 fix the remaining Phase 5 semantics before implementation:
  Wait preserves semantic resume versus retry identity and adds an independent
  PostgreSQL deadline wake source; failure notification is an atomic bounded
  execution-domain intent whose delivery can never alter terminal run truth.
- The Wait completion checkpoint adds strict `core.wait@1` duration
  validation from 1 through 2,592,000 seconds, bounded pass-through execution,
  `suspends_run`, stable preview rejection, and retained staged/active epochs 15
  and 16 while leaving the default serving cohort unchanged. Migration 0033
  persists explicit `node_wait`/`retry_backoff` and
  `execute`/`retry`/`wait_resume` identity, enforces exclusive timing columns,
  and adds an independently claimed PostgreSQL deadline wakeup marker and
  transactional coordinator outbox. The production attempt store computes the
  resume timestamp from database time in the same completion transaction,
  releases the attempt lease, preserves output, and rejects a suspension racing
  committed cancellation/deadline control. A due semantic wait creates one
  immutable resume attempt that loads the preserved output without invoking or
  rearming Wait. Disposable PostgreSQL proves atomic suspension, no early wake,
  duplicate completion, exact two-attempt resume, independent concurrent
  deadline wakeup, readiness and zero/prior-head migration. Root `pnpm check`
  passes, as do all 253 database integration assertions on a clean PostgreSQL
  18 database and the focused real SQL/outbox/BullMQ due-retry assertion after
  explicit delay-kind fixture migration. The real recovery assertion now mixes
  one retry and one semantic Wait, stops the pre-due coordinator, starts fresh
  coordination after the deadline, fails publication through unavailable Redis,
  retries the durable outboxes through BullMQ, and admits exactly one `retry`
  and one `wait_resume` attempt with no duplicate scan result. Existing worker
  drain and PostgreSQL fail-closed gates remain green. Wait is complete; Phase 5
  remained in progress for failure notification and phase-wide fixed-head review.
- The failure-notification completion checkpoint implements ADR 022 as an
  execution capability, never a workflow node or catalog release. Browser-safe
  workflow-model contracts enforce one strict V1 policy, a deterministic safe
  context capped at 4,096 UTF-8 bytes, and bounded channel-neutral delivery
  results. The queue contract carries only workspace, intent, outbox, schema,
  and optional trace identifiers. Migration `0034_run_failure_notifications.sql`
  pins the immutable destination policy on accepted runs, adds forced-RLS intent
  and append-only audit relations, least-privilege grants, lifecycle constraints,
  recovery indexes, and a bounded due-recovery function. Readiness now requires
  this exact migration head and compatible notification schema/grants.
- The production coordinator creates the intent, safe context checksum,
  `intent_created` audit fact, and identifier-only outbox in the same CAS
  transaction that commits `failed`, `timed_out`, or `outcome_unknown` run truth.
  Deterministic run/event/policy identity makes duplicate coordinator work inert;
  success and explicit cancellation create no intent. The database delivery
  store verifies authoritative outbox and context checksums under workspace RLS,
  claims with a pre-call dispatch marker, keeps a stable provider idempotency
  key, schedules bounded safe/idempotent retries, dead-letters exhaustion, and
  classifies unsafe crash ambiguity as `outcome_unknown` without changing run,
  checkpoint, invocation, or event truth.
- The readiness-gated maintenance consumer injects the provider-neutral delivery
  capability and runs PostgreSQL recovery only when that capability is enabled.
  Unit proofs cover safe-payload rejection, delivered and duplicate-terminal
  behavior, timeout ambiguity, coordinator deduplication, RLS isolation, retry
  exhaustion, dead-letter audit, and unchanged terminal run truth. The disposable
  PostgreSQL/BullMQ recovery assertion marks dispatch, simulates a worker crash,
  starts a fresh maintenance runtime, reconstructs a retry outbox from PostgreSQL,
  performs exactly one provider call with the stable key, makes exact queue
  redelivery inert, and preserves run status, checkpoint revision, and event
  count. Provider-specific Slack/email adapters remain correctly deferred to
  Phase 6.
- Final local verification on Node 24, pnpm 11.22.0, PostgreSQL 18.6, Redis
  8.2.8, BullMQ 6.1.2, and S3Mock 5.1.0 passes root `pnpm check` with 862 unit
  assertions. The enabled sequential real-service matrix passes 2 artifact-store,
  254 database, 22 worker, and 7 API assertions; database execution includes
  zero-state and supported prior-head upgrades through `0034`. The notification
  PostgreSQL vertical slice is part of the 39-assertion coordinator store file;
  the worker PostgreSQL/Redis/BullMQ file passes 9 assertions in 13.126 seconds,
  and the complete worker integration matrix passes in 77.69 seconds.
- Retained gates pass five Phase 0E process/recovery assertions in 41.602 seconds,
  one SSE Redis-loss assertion in 6.975 seconds, one sequential Redis/PostgreSQL/
  drain assertion in 16.024 seconds, and one additive compatibility rollout
  assertion in 714 ms. The Phase 0E gate exposed a retained V1 synthetic-loop
  recovery regression: legacy iteration invocations intentionally omit explicit
  scope while the strengthened invariant searched only explicit `iterationPath`.
  The engine now verifies those retained invocations by their canonical scoped
  key, with a focused unit regression, while structured loops retain strict scope
  validation. PostgreSQL and Redis recovered healthy, Redis returned `PONG`,
  resilience DB 15 was empty, and all three Compose dependencies were healthy.
- Independent Spec and Standards re-reviews of the full Phase 5 range
  `28ae56b...9d7e071` both issue GO against the same pushed immutable head. The
  Spec review confirms all Phase 5 plan requirements and ADRs 017-022, including
  the corrected direct Parallel-to-Merge publication and explicit `missing`
  ledger behavior. The Standards review confirms PostgreSQL-authoritative
  notification retry timing and no remaining documented-standard blocker.
  Nonblocking review notes are the pre-existing structured-port derivation
  duplication, the broad `audit` helper name, and unrelated README/mailmap/CI
  additions in the reviewed range; none changes Phase 5 runtime correctness.
- The first fixed-head Standards review of `974f764` found one blocking clock-
  authority defect: notification retry scheduling and eligibility used the
  worker clock. A disposable-PostgreSQL regression skewed `Date.now()` to 2099
  and first reproduced a retry roughly 72 years late; the delivery store now
  computes `next_delivery_at` and checks whether it is due with
  `clock_timestamp()`. The same proof verifies a skewed worker cannot claim the
  retry early. The fixed-head Standards re-review at `9d7e071` issues GO.
- The first fixed-head Spec review of `974f764` found that publication rejected
  valid direct Parallel-to-Merge paths and production could not derive the
  corresponding explicit `missing` ledger disposition. Red-green executable
  proofs now accept each direct matching branch, persist canonical `missing`
  entries for those graph-declared empty paths, settle the complete ledger, and
  admit Merge without weakening fail-closed handling for absent non-empty branch
  work. The fixed-head Spec re-review at `9d7e071` issues GO.

Incremental publishable slices, in required order:

- [x] Condition: versioned schemas and executor; exactly one deterministic
      branch selected and every unreachable branch explicitly skipped.
- [x] Switch: bounded ordered cases plus default behavior; canonical branch IDs
      and selection independent of canvas or object-key order.
- [x] Bounded Parallel: declared branches become ready concurrently while the
      pinned run/workspace limit bounds admissions and cancellation stops new
      branches.
- [x] Merge: explicit `all`, `any`, and bounded `count(n)` policies settle only
      from the complete persisted branch ledger; selected branches use canonical
      branch-ID order and unsatisfied joins fail terminally.
- [x] Bounded For Each: one isolated structured DAG body, collection evaluated
      once from canonical input, stable zero-based ordinals, pinned maximum
      iterations/concurrency, run-wide 1,000-iteration budget, and no truncation.
- [x] Wait: PostgreSQL owns `resumeAt`, checkpoint revision, and due-work lease;
      no sleeping worker or BullMQ timer is authoritative, and duplicate due
      delivery resumes one logical invocation no earlier than its deadline.
- [x] Failure notification: versioned bounded input/output and safe failure
      context, with no secret/provider body leakage or alternate scheduler state
      authority.

Every slice must pass before the next begins:

- [x] Add canonical vocabulary, browser-safe Zod contracts, manifest, executor,
      compatibility release, generated artifacts, and server-only boundaries for
      node slices; apply ADR 022's capability contracts and server-only delivery
      boundary without inventing a notification node, manifest, or release.
- [x] Keep node definitions absent from placement/publication/admission until
      their complete slices pass; ADR 022 permanently keeps notification outside
      graph placement, publication, admission, and node compatibility releases.
- [x] Prove graph validation, tenant/authorization scope where applicable,
      transaction boundaries, stable safe errors/logs, cardinality-safe
      telemetry/audit/usage effects, timeout/retry/cancellation, and bounded
      inputs/outputs/checkpoints.
- [x] Prove happy path, quota rejection, duplicate coordinator and attempt jobs,
      crash on both sides of checkpoint commit, Redis loss, PostgreSQL loss,
      process drain, and fresh-worker reconstruction from immutable version plus
      checkpoint only where applicable; notification substitutes duplicate
      delivery, dispatch-marker crash recovery, and immutable intent/context
      reconstruction because it has no node attempt, graph version, or quota.
- [x] For branch/join slices, prove explicit arrived/skipped/missing/failed/
      canceled dispositions, output keys by source node/port, completion-order
      independence, and no duplicate join scheduling.
- [x] For For Each, prove exact and over-limit collections, nested worst-case
      expansion, iteration-budget exhaustion before admission, bounded
      concurrency, stable scoped invocation keys, duplicate outcomes, and
      cancellation between batches.
- [x] For Wait, prove long suspension consumes no worker slot, due-work recovery
      after Redis/worker restart, no early resume, duplicate delivery, and
      durable cancellation/deadline behavior.

Phase-wide completion gates:

- [x] Run root `pnpm check`, zero-to-head and supported prior-head migrations,
      the complete real-service matrix sequentially, and all applicable Phase
      0D/0E plus Phase 3/4 recovery and retained-release fixtures.
- [x] Record exact versions, commands, assertion counts, timings, cleanup, and
      post-test dependency health.
- [x] Resolve every blocker/high finding from independent Spec and Standards
      reviews against one fixed Phase 5 implementation commit.
- [x] Mark Phase 5 complete only after every box above has direct evidence and
      all coherent implementation/evidence commits are pushed.

## Phase 6 — V1 Providers And Triggers

Status: **Complete**

Authority and sequencing:

- [x] Accept ADR 023 before fixing the Slack action's published identity,
      credential form, bounds, and ambiguous-dispatch behavior.
- [x] Complete Slack `send_message` as one staged then active provider slice.
- [x] Accept ADR 024 for the Resend-backed email action's published contract,
      credential form, disclosure-gated test, and bounded idempotency window.
- [x] Complete email `send_notification` as one staged then active provider
      slice.
- [x] Accept ADR 025 for immutable Slack/email failure-notification
      destinations, workflow policy, connection fencing, and delivery outcomes.
- [x] Add versioned Slack and email destinations behind ADR 022 without changing
      terminal run truth or introducing notification nodes.
- [x] Accept ADR 012 before enabling any production trigger reconciliation or
      acceptance path.
- [x] Add the ADR 012 execution-admission foundation: immutable versioned
      workspace entitlements, a single effective projection, five-active/100-
      queued defaults, PostgreSQL-authoritative reconciled counters, exact
      replay-before-quota ordering, queued and active slot lifecycle enforcement,
      and durable fair outbox rotation independent of BullMQ ordering.
- [x] Accept ADR 013 before retaining webhook delivery payloads or history.
- [x] Accept ADR 026 for generic webhook signature/replay semantics before
      implementing raw-byte verification and deduplication.
- [x] Complete webhook
      reconciliation, raw-byte verification, deduplication, and run acceptance.
- [x] Accept ADR 014 before implementing Schedule.
- [x] Complete Schedule and prove timezone, DST,
      misfire, PostgreSQL authority, and recovery behavior.
- [x] Keep polling deferred unless launch validation explicitly promotes it.

Slack `send_message` completion gates:

- [x] Add browser-safe strict config/input/output contracts, manifest identity,
      server-only executor, stable safe errors, telemetry, and redaction.
- [x] Extend connection contracts and persistence with workspace-scoped
      `slack`/`slack_bot_token` creation, rotation, revocation, current-version
      fencing, audit, and bounded real `auth.test` behavior.
- [x] Prove exact Slack request/response bounds, disabled redirects and hidden
      retries, 429 handling, timeout/cancellation, definite failure, and unsafe
      `outcome_unknown` classification after possible dispatch.
- [x] Prove offline validation and disclosure-gated real preview execution with
      no production run, checkpoint, usage, or trigger-state mutation.
- [x] Prove production attempt execution, duplicate delivery, crash boundaries,
      Redis loss, PostgreSQL failure, drain, credential rotation/revocation, and
      safe observability with a controllable Slack double and real infrastructure.
- [x] Add staged and active compatibility releases only after every preceding
      Slack gate passes; retain all older releases and verify API/worker overlap.

Email `send_notification` completion gates:

- [x] Add browser-safe strict config/input/output contracts, manifest identity,
      server-only Resend executor, stable safe errors, telemetry, and redaction.
- [x] Extend connection contracts and persistence with workspace-scoped
      `email`/`resend_api_key` creation, rotation, revocation, current-version
      fencing, audit, and disclosure-gated test-recipient delivery.
- [x] Prove fixed-origin bounded requests, stable identical idempotency keys and
      payloads, durable provider-dispatch binding across attempts, disabled
      redirects and hidden retries, response/error bounds, definite refusal,
      429/concurrent retry, and ambiguous transport retry.
- [x] Prove offline validation and disclosure-gated real preview execution with
      no production run, checkpoint, usage, or trigger-state mutation.
- [x] Prove production attempt execution, duplicate delivery, crash boundaries,
      Redis loss, PostgreSQL failure, drain, credential rotation/revocation, and
      safe observability with a controllable Resend double and real services.
- [x] Add staged and active compatibility releases only after every preceding
      email gate passes; retain all older releases and verify API/worker overlap.

Failure-notification destination completion gates:

- [x] Add workspace-scoped destination identities, immutable Slack/email config
      versions, optimistic updates, disable behavior, RLS, audit, and strict API
      contracts without exposing provider or secret material.
- [x] Add one workflow policy reference outside graph topology and atomically pin
      its exact active destination version and side-effect class into every new
      manual, webhook, and schedule run.
- [x] Compose provider-neutral delivery over the proven Slack and Resend clients,
      deterministic ADR 022 safe messages, exact connection/config fencing,
      bounded provider references, and fail-closed readiness.
- [x] Prove Slack definite retry versus unsafe ambiguity, Resend identical-key
      recovery, changed credentials, policy/config changes after run acceptance,
      duplicate delivery, crashes, PostgreSQL/Redis loss, drain, and no recursive
      notification or terminal-run mutation.
- [x] Activate destination production and recovery consumers only after the full
      real-service matrix passes with both providers and retained run truth.

Phase-wide completion gates:

- [x] Complete Slack, email, failure-notification destinations, Webhook, and
      Schedule in that order; do not add polling.
- [x] Run root checks, provider contracts, zero/prior-head migrations, complete
      real-service matrices, retained recovery fixtures, and additive rollout.
- [x] Record exact versions, commands, assertion counts, timings, cleanup, and
      post-test dependency health.
- [x] Resolve every blocker/high finding from independent fixed-head Spec and
      Standards reviews and push all coherent implementation/evidence commits.

Current evidence:

- ADRs 012–014 and 026 are accepted before trigger implementation. PostgreSQL
  owns entitlement admission and fair rounds, retention/deletion/hold progress,
  schedule occurrences, and webhook replay truth. Generic webhook ingress uses
  exact-raw-byte HMAC with a five-minute window and 256-KiB JSON limit; Schedule
  pins five-field local cron/interval, IANA timezone, deterministic DST and
  misfire behavior, and requires implementation to pin `cron-parser` 5.10.0
  directly before Schedule is exposed.
- The API direct-webhook integration gate provisions a fresh disposable
  PostgreSQL database, advances the real compatibility release history,
  publishes and reconciles a `core.webhook@1` workflow, provisions the endpoint
  through the production database and envelope-cryptography seams, and sends
  exact raw bytes through a loopback Nest/Fastify listener. Its 34 assertions
  prove atomic delivery/run/event/checkpoint/outbox acceptance, exact and
  concurrent replay, changed-key conflict, malformed-JSON and quota rollback,
  current/previous secret rotation boundaries, bounded database failure, and no
  raw envelope, signature, endpoint key, signing secret, or non-identifier
  queue payload leakage. The focused test completed in 343 ms (3.66 seconds
  including migration, release rollout, app startup, and cleanup), and dropped
  its disposable database.
- The direct Schedule worker gate publishes a real `core.schedule@1` graph,
  dispatches its transactional publication outbox through Redis/BullMQ, and
  materially reconciles the schedule under the worker role before using the
  production PostgreSQL scanner and checkpoint factory. It proves one unique
  occurrence/run/event/checkpoint/outbox through duplicate reconciliation and
  competing scans, PostgreSQL-seeded due identity, expired-lease recovery in a
  fresh runtime, visible admission deferral without starving a second workspace,
  recovery after capacity returns, and no post-drain claim. The gate exposed and
  fixed worker Schedule acceptance privileges at migration head
  `0042_worker_run_admission_lock.sql`; PostgreSQL retains lifecycle and failure-
  notification locks behind narrow security-definer functions rather than
  granting workspace or destination mutation. The focused test body completed
  in 1,003 ms (3.55 seconds including migration, release rollout, Redis/BullMQ,
  and cleanup), dropped its disposable database, and left isolated Redis DB 13
  empty.
- Final trigger hardening through `de28879` makes the PostgreSQL endpoint ingress
  limiter mandatory before every KMS decrypt, keeps generated credentials out of
  webhook command identity, persists a separately constrained 30-day run-input
  expiry at migration `0043_workflow_run_input_retention.sql`, and emits bounded-
  cardinality Webhook delivery/deduplication/health and Schedule lag/scan/
  reconciliation/health telemetry. Webhook ingress now extracts an incoming W3C
  parent when valid, starts `webhook.ingress`, and persists the active span context
  for outbox and worker continuation. Independent fixed-head Spec and Standards
  re-reviews found no implementation blocker/high after these corrections.
- Final verification on 2026-08-25: root `pnpm check` passes formatting, builds,
  lint, generated-contract drift, typechecks, and 1,021 unit assertions,
  including real OpenTelemetry export proof that Webhook ingress continues a
  remote parent and persists its child context;
  `pnpm audit --prod` reports no known vulnerabilities. A fresh PostgreSQL 18
  database applies all 44 migrations through `0043` and passes 288 assertions
  across 21 sequential integration files. The direct Webhook gate passes in
  3.75 seconds, the direct Schedule gate passes in 3.84 seconds, and additive
  compatibility rollout passes against a freshly migrated disposable database
  in 4.20 seconds; each disposable database was dropped. Commit `0f8a170`
  corrects the retained Phase 0E fixture to drain bounded ADR 012 fairness
  rounds rather than assuming one dispatcher claim drains multiple rows from
  the same workspace. Diagnostic evidence confirmed the child had reported and
  the parent had consumed `{ ready: true }`; the first round had correctly
  published only the older coordinator row, leaving the node-attempt row in
  PostgreSQL for the next fair round. With production fairness and every
  readiness/recovery assertion unchanged, all five process-recovery cases pass
  in 41.979 seconds, including both Redis-backed cases. A fixed-head Spec review
  and Standards review of `a87d204...0f8a170` report no findings. The final
  fixed-head root `pnpm check` and `pnpm audit --prod` also pass, with 1,021 unit
  assertions and no known production vulnerabilities. PostgreSQL 18, Redis
  8.2.8, and the artifact store remained healthy after verification. This closes
  the final Phase 6 completion gate.
- Migration `0038_execution_admission.sql` provisions existing and new
  workspaces with immutable entitlement version 1 (five active, 100 queued), a
  forced-RLS current projection, and reconciled queued/active counters. Run
  insertion and coordinator status transitions serialize on workspace admission
  state; waiting retains the active allowance, terminal queued/active state
  releases it, stale or duplicate transitions cannot double-release it, and a
  workspace-scoped counter repair function recomputes from authoritative runs.
  Exact acceptance replay still resolves before current workspace or
  entitlement checks. Quota exhaustion maps to stable
  `workspace.quota_exceeded` RFC 9457 `429` with bounded `Retry-After: 5`.
- The outbox dispatcher now performs a bounded `SKIP LOCKED` fairness round with
  at most one due row per workspace and advances a PostgreSQL cursor in the same
  claim transaction. Queued coordinator work acquires a durable active-capacity
  reservation in that transaction, so capacity-blocked work stays in PostgreSQL
  and never reaches BullMQ; transitions and terminal publisher failures release
  reservations without opening excess capacity. Published coordinator
  reservations become recoverable after a bounded lease, so Redis loss reopens
  the same durable delivery under a fresh outbox/BullMQ identity instead of
  colliding with retained terminal jobs or stranding the run and its allowance.
  Saturated workspace windows still advance the durable cursor, and a fresh
  dispatcher instance continues after it, while queue contracts and identifier-
  only BullMQ jobs remain unchanged; preview admission and cleanup code are
  untouched.
- Focused verification on 2026-08-25: a fresh PostgreSQL 18 database applied all
  39 reviewed revisions from zero through `0038`; the exact prior-head path is
  covered by the disposable coordinator matrix. Database unit tests pass 69
  assertions. Disposable PostgreSQL suites pass 34 acceptance assertions
  (including 101 concurrent requests with exactly 100 accepted), 40 coordinator
  assertions, and 19 outbox/dispatcher assertions. The focused API problem and
  persistence suites pass 14 assertions, and root `pnpm check` passes formatting,
  builds, lint, contract drift, typechecks, and 954 unit assertions. At that
  checkpoint the Webhook and Schedule slices were unfinished; the later trigger
  evidence above supersedes that implementation status.
- ADR 023 fixes `slack.send_message@1` as an unsafe ABI 2 action with strict
  browser-safe schemas, a single `slack_bot_token` slot, fixed
  `chat.postMessage`/`auth.test` endpoints, no redirects or hidden retries, a
  64-KiB response cap, bounded `Retry-After`, and no automatic replay after an
  ambiguous dispatch. The server-only executor fences the current encrypted
  secret version immediately before ADR 007 dispatch evidence and clears secret
  bytes after use.
- Migration `0035_slack_bot_token_connections.sql` extends the connection auth
  constraint without weakening workspace RLS. Contract, API, and real PostgreSQL
  tests prove creation, encrypted rotation, revocation, credential-access audit,
  current-version fencing, and bounded real-client `auth.test` classification;
  generated client/OpenAPI artifacts include the discriminated Slack request.
- `packages/integrations/test/slack-send-message.test.ts` proves the exact JSON
  request, inaccessible unfurls, fixed endpoint, one-call behavior, strict
  channel/text/timestamp bounds, redaction-sensitive request metadata, 429,
  authentication and channel failures, pre-dispatch retry, cancellation, and
  post-dispatch `outcome_unknown`. It also distinguishes definite Slack refusal
  and rate-limit responses (`possiblyDispatched: false`) from Slack's documented
  ambiguous `internal_error` and unexpected 5xx responses, so the unsafe retry
  policy cannot suppress a definite retry or replay an ambiguous send. Worker
  telemetry tests allow only bounded provider, operation, outcome, error-class,
  and dispatch attributes.
- The production node-attempt real-service fixture activates retained releases
  sequentially through Slack epoch 18, executes HTTP then Slack through real
  PostgreSQL, BullMQ, Redis, encrypted JIT credential access, and the shared
  artifact boundary, and proves dispatch marking, bounded persisted output, one
  credential audit, inert exact redelivery, and absence of token/message text
  from durable and queue surfaces. The direct production-preview invoker proof
  executes the same active Slack executor and current-version fence; the retained
  real preview matrix supplies disclosure, duplicate, crash-boundary, SIGKILL,
  reconciliation, expiry, and no-production-mutation proofs.
- Retained releases 17/18 stage then activate Slack. Catalog tests prove staged
  non-serving epoch 16, `[16,17]` staging support, `[17,18]` activation support,
  ABI 2 lifecycle transition, active execution, and all 18 unique fingerprints.
  The real PostgreSQL additive rollout records and verifies both API and worker
  preactivation for every transition through epoch 18.
- Verification on 2026-08-24: root `pnpm check` passed 880 unit assertions;
  zero-to-head migration applied all 36 migrations through `0035`;
  the flagged real-service matrix passed 255 database, 22 worker, 7 API, and two
  artifact-store assertions; focused Slack production attempt and compatibility
  rollout each passed one assertion; focused worker unit tests pass 153
  assertions. A reused-database worker rerun initially claimed four stale outbox
  rows in one transport assertion; that five-assertion file passed after the
  stale rows were consumed, while all other 17 worker assertions were green.
- Official Resend documentation confirms fixed `POST /emails` JSON delivery,
  sending-only domain-restricted API keys, a documented test recipient, UUID
  responses, bounded 256-character idempotency keys, identical-response replay,
  and 24-hour idempotency retention. ADR 024 limits automatic retries to the
  much shorter accepted engine V1 retry horizon.
- The strict browser-safe email contract permits one normalized ASCII mailbox,
  bounded subject and plain text, one `resend_api_key` connection, and no HTML,
  attachments, extra recipients, dynamic sender, or arbitrary endpoint. The
  server-only client issues only `POST https://api.resend.com/emails`, disables
  redirects and hidden retries, caps responses at 65,536 bytes, clears request
  and response bytes, and preserves the stable engine idempotency key. Twenty-four
  focused integration-package assertions cover exact request bytes, credential
  fencing and zeroing, cancellation, 429 and concurrent-request retry, ambiguous
  transport retry, and definite 400/401/403/422 and invalid-key refusal. They
  also prove identical binding/key/payload replay after a post-dispatch crash,
  fail-closed secret-version mismatch before provider bytes, first-attempt
  rotation/revocation refusal, historical ambiguity after prior dispatch, and
  bounded binding-mismatch identity across the real Secure HTTP boundary while
  generic dispatch-marker infrastructure failure remains retryable. Historical
  ambiguity is a separate derived runtime fact rather than an inference from the
  persisted identity binding: repeated definite 429 retries remain retryable and
  never become falsely unknown.
- Public connection contracts now admit only the `email`/`resend_api_key`
  pairing and require an explicit side-effect disclosure for testing. The test
  path sends a fixed bounded message only to `delivered@resend.dev` through the
  production client, derives its provider key from both connection ID and
  command key, and persists only bounded safe health state. Dispatched claims
  survive abandonment and age and cannot be reclaimed; callers must use a new
  command key for a deliberate new send. Migration
  `0036_resend_api_key_connections.sql` extends the existing auth-type
  constraint and adds bounded format-constrained non-secret dispatch bindings
  to logical node runs and preview attempts with narrow worker update grants.
  Fourteen focused real PostgreSQL assertions prove clean creation, encrypted
  rotation, revocation, current-version fencing, audit, fail-closed stale
  dispatched claims, the supported `0020` upgrade, and the exact
  `0035`-to-`0036` prior-head path on disposable databases.
- Retained releases 19/20 stage then activate email without removing any older
  release. Catalog tests prove staged non-serving and active execution cohorts,
  all 20 unique fingerprints, and API/worker overlap. The additive rollout proof
  preactivated both roles for every retained transition through epoch 20 and
  passed in 2.78 seconds.
- The production node-attempt fixture executes HTTP, Slack, then email through
  real PostgreSQL, Redis, BullMQ, encrypted just-in-time credential access, and
  the artifact boundary. Its direct recovery path commits an ambiguous first
  dispatch, lets the coordinator and due-wakeup scanner admit attempt two, and
  proves exact provider-key, payload, and persisted-binding reuse before success.
  A second email path rotates the credential after its ambiguous first dispatch;
  attempt two then records explicit `outcome_unknown` without dispatch evidence
  or provider bytes, and the coordinator preserves that terminal truth. The same
  fixture proves inert exact redelivery, bounded output, drain, and absence of
  both API keys, sender, recipient, subject, and text from durable and queue
  surfaces. The direct production-preview invoker also executes the active email
  cohort with the same binding and current-version fence. Focused production and
  preview PostgreSQL transitions prove historical binding hydration, first bind,
  same-binding replay, rotated-binding rejection, and atomic active/current
  connection fencing under rotation and revocation immediately before dispatch.
  The marker transaction also uses a narrowly executable provider-neutral fence
  function to join and lock the workspace and connection in workspace-first
  order; suspended workspaces fail before binding or marker persistence without
  granting the worker workspace-update authority.
- Post-dispatch cancellation and deadline classification now treats every
  non-safe attempt, including `idempotent_with_key`, as `outcome_unknown` when
  dispatch may have occurred and control prevents retry/reconciliation. Safe
  cancellation remains canceled, and pre-dispatch failures retain their
  definite classification.
- Verification on 2026-08-25: `pnpm check` passes formatting, builds, lint,
  generated-contract drift, typechecks, and 916 unit assertions; focused
  integration-package tests pass 116 assertions.
  A fresh disposable PostgreSQL 18 database migrated all 37 revisions from zero
  through `0036`; the complete sequential real-service matrix passed 257
  database, 22 worker, seven API, and two artifact-store assertions. The focused
  exact-prior-head connection suite passed 14 assertions, and the additive
  rollout passed one assertion. All test-created databases were dropped; the
  dedicated gate database is removed after final verification. PostgreSQL,
  Redis, and the artifact store remained healthy. Phase 6 remains in progress
  because failure-notification destinations, Webhook, and Schedule are not
  implemented.
- Blocker-fix verification on 2026-08-25: focused production/preview/connection
  PostgreSQL suites passed 72 assertions, including the exact prior-head
  migration, worker grants, binding hydration, and connection-marker races.
  Focused worker tests passed 41 assertions, the workflow-engine regression file
  passed 51 assertions, and the flagged real worker recovery path passed one
  assertion on a fresh 37-migration database in 7.04 seconds, including durable
  `pending` to `retry` coordination after a definite 429 and a successful second
  claim without false ambiguity. The production and preview PostgreSQL marker
  tests additionally prove suspended-workspace refusal, unchanged binding/marker
  state, active-workspace success, and unresolved-state hydration without adding
  a persisted secret or ambiguity column. No commit or push was made.
- ADR 025 implementation work on 2026-08-25 added migration
  `0037_failure_notification_destinations.sql`, strict public configuration
  schemas, a tenant-scoped destination/policy database adapter and Nest routes,
  acceptance-time policy/config/side-effect/secret pinning, and production
  Slack/Resend notification delivery with JIT credential audit, deterministic
  ADR 022 text, final dispatch fencing, and a nonsecret email delivery binding.
  A disposable PostgreSQL 18 database migrated zero-to-head and an exact
  `0036` prior head applied only `0037`; direct database execution proved create,
  append from version 1 to 2, policy set, disable/enable, list, pinned policy
  resolution, and cross-workspace hiding. `pnpm check` passed 918 assertions
  before two focused contract assertions were added; the focused worker suite
  passed 161 assertions and PostgreSQL/Redis health checks returned ready/PONG.
  The ordinary shared-service `pnpm test:integration` was also attempted and
  was not completion evidence: suites using the known reusable database failed
  on its pre-existing `0012` checksum mismatch, while fresh suites exposed
  expected-head fixture drift and one coordinator fixture that still constructs
  caller-supplied notification policy without the new pinned secret. The
  destination completion boxes remain unchecked until command idempotency,
  canonical generated OpenAPI/client artifacts, direct API/database integration
  files, complete pinning/replay and provider recovery/service-loss assertions,
  and the full disposable real-service matrix are green.
- ADR 025 destination/API checkpoint verification on 2026-08-25 completes the
  workspace-scoped destination identity and provider-neutral delivery gates.
  Mutating API commands require bounded `Idempotency-Key` headers and atomically
  persist actor-scoped request hashes, result snapshots, destination/policy
  changes, and deduplicated audit facts; changed requests conflict. The Nest
  controller uses established session, CSRF, `connection:manage`, and
  `workflow:update` guards, RFC 9457 mapping, fixed-cardinality telemetry, and
  generated OpenAPI/client artifacts. Strict public configs contain only
  `{ connectionId, channelId }` or `{ connectionId, toEmail }`.
- A populated exact-`0036` migration fixture preserves historical terminal rows,
  quarantines orphan `pending` and `retry` intents as bounded
  `delivery.destination_unavailable` dead letters, and preserves the possible
  dispatch truth of historical `dispatching` intents as `outcome_unknown` with
  `delivery.recovery_ambiguous`, `possibly_dispatched=true`, and matching audit
  facts. Their
  retained outbox deliveries claim terminally without context parsing or provider
  calls. `NOT VALID` destination-version and exact composite run-pin foreign keys
  preserve historical rows while an insert trigger rejects every new null or
  mismatched run pin.
  Clean and prior-head fixtures, forced RLS, least-privilege grants, immutable
  versions, optimistic append, status changes, cross-workspace hiding, replay,
  and no duplicate audit are executable. Manual acceptance pins destination
  version 1 and secret version 1; exact replay keeps those pins after config
  append, disable, and credential rotation, while a new run after disable has
  no notification policy. A destination disabled after acceptance preserves the
  original run/intent pin and audit identity but fails closed before any new
  provider fence or bytes; changed current credentials also fail closed.
- Delivery classification proves definite Slack `service_unavailable`/429
  retries without unsafe replay, terminal Slack 5xx/invalid-response ambiguity,
  identical email binding/key/payload recovery, first-fence refusal, historical
  email identity loss, and exhausted ambiguous email `outcome_unknown` truth.
  The real PostgreSQL/Redis/BullMQ notification recovery path uses the production
  provider adapter and durable fence for both providers. Email recovers a durable
  pre-dispatch crash and delivers once with the same binding/key/payload. Slack
  fences once, classifies a post-dispatch invalid response as terminal
  `outcome_unknown`, and never sends again on exact BullMQ redelivery. Neither
  path mutates terminal run/checkpoint/event truth, and durable notification
  surfaces contain no credential, target, sender, or message content.
- Final checkpoint commands are green: root `pnpm check` passes all builds,
  formatting, lint, generated-contract drift, typechecks, and 929 unit
  assertions; generated destination contracts pass 16 assertions. A fresh
  PostgreSQL 18 database runs the complete sequential database matrix with 259
  assertions, including zero-to-`0037` and populated `0036`-to-`0037` paths.
  The enabled worker real-service matrix passes 18 assertions against PostgreSQL
  18, Redis 8.2.8, and BullMQ 6.1.2; the focused notification recovery assertion
  passes with the real provider adapter seam. `git diff --check`, PostgreSQL
  `pg_isready`, Redis authenticated `PONG`, and Docker health checks pass.
- The ADR 025 destination consumer is wired and its two-provider recovery fixture
  passes. The shared PostgreSQL/Redis-loss and drain matrices also pass, but they
  are not a substitute for direct destination cases: PostgreSQL loss before the
  final provider fence, Redis loss after notification intent/outbox commit, and
  shutdown during blocked destination delivery still need executable
  service-stop/restart coverage for both provider paths. The corresponding
  destination completion gates remain open.
  The all-trigger pinning gate remains unchecked because webhook and schedule
  acceptance do not yet exist; all Phase 6-wide gates therefore remain
  unchecked. No commit or push was made.
- Independent-review fixes on 2026-08-25 split notification claim from provider
  dispatch. `pending`/`retry` now become recoverable `claimed` rows without
  dispatch evidence; the full immutable destination, provider/auth, secret,
  workspace, attempt, and binding fence atomically enters `dispatching`
  immediately before provider bytes. Expired `claimed` rows retry safely, while
  expired `dispatching` preserves Slack ambiguity and email idempotent recovery.
  Persisted email ambiguity is separate from the stable delivery binding:
  initial post-dispatch 5xx/invalid transport retries set unresolved truth,
  subsequent non-success becomes `outcome_unknown`, repeated definite 429s stay
  retryable, and exhausted unresolved delivery never dead-letters.
- The worker real-service fixture now creates separate email and Slack runs by
  actual acceptance plus `CoordinatorRunStore` terminalization; it no longer
  injects a second provider intent for one run. Focused PostgreSQL/Redis/BullMQ
  execution passes with email predispatch recovery, Slack terminal ambiguity,
  exact redelivery inertia, immutable terminal run/checkpoint/event truth, and
  durable leakage checks. The complete disposable PostgreSQL matrix passes 259
  assertions, the enabled worker matrix passes 18 with four intentional skips,
  destination contracts pass 16, and provider delivery unit coverage includes
  bounded blocked KMS, KMS failure, malformed/local classification, repeated 429,
  and post-fence network ambiguity. Disposable databases were dropped and Redis
  DB 12 was flushed. No commit or push was made.
- The remaining independent-review correctness fixes are executable. A
  `dispatching` intent with durable possible-dispatch evidence now terminalizes
  as `outcome_unknown` regardless of an unsafe handler's fallback `retry`
  classification; the real Slack path throws unexpectedly after its final fence
  and remains terminal and inert. Exact clear-policy replay is resolved before
  current workflow visibility, including after workflow deletion, while a new
  key remains not found. Envelope encryption and key-provider APIs propagate an
  optional abort signal through AWS KMS send options, check cancellation around
  local cryptography, and zero plaintext returned after a signal-ignoring late
  KMS response. Destination loading owns a signal-aware transaction, destroys an
  active PostgreSQL client on abort, and applies a 30-second local statement
  timeout instead of abandoning a raced query promise.
- Verification after those fixes: `pnpm check` passes formatting, all builds,
  lint, generated-contract drift, typechecks, and 941 unit assertions. A fresh
  disposable PostgreSQL database passes all 259 integration assertions,
  including populated `0036` migration and deletion-replay cases. An isolated
  worker matrix passes 18 PostgreSQL/Redis/BullMQ assertions with four
  intentional skips, including coordinator-created email recovery and Slack's
  unexpected post-fence exception. The reusable local database still has the
  known historical `0012` checksum mismatch and was not used as completion
  evidence. Direct provider-specific PostgreSQL-stop, Redis-stop/restart, and
  blocked-delivery drain cases remain open, so destination and Phase 6 gates
  remain unchecked. No commit or push was made.
- Run-pin and direct service-loss follow-up on 2026-08-25 strengthens every new
  non-null run pin at the database write boundary. The trigger safely parses the
  exact immutable destination config, requires active workspace/destination/
  connection identity, enforces Slack/unsafe or email/idempotent-with-key with
  the exact provider/auth pair, and accepts only the configured connection's
  current secret version. The shared acceptance resolver now locks mutable rows
  in separate statements before reading the immutable secret, avoiding a
  pre-wait PostgreSQL join snapshot that could silently drop a policy during
  credential rotation. Direct integration cases reject wrong class, unrelated
  secret, wrong provider/auth, and disabled destination, revoked connection, or
  suspended workspace without a run row; destination-disable and credential-
  rotation races serialize to no pin or the newly committed exact pin.
- The isolated coordinator destination matrix now stops PostgreSQL after real
  coordinator terminalization and before `fenceDispatch` for both Slack and
  email. Dispatcher readiness fails closed, destination loading returns a
  definite pre-dispatch retry, credential/provider adapters receive zero calls,
  and both expired `claimed` rows recover as retry with
  `possibly_dispatched=false`. It also stops Redis after both intent/outbox
  commits: dispatcher readiness/admission fails closed, PostgreSQL truth remains
  retryable, and a fresh runtime after restart backfills four original/recovery
  outboxes. Email sends once with its exact deterministic key; Slack crosses its
  fence once, terminalizes the injected unexpected exception as
  `outcome_unknown`, and both duplicate queue replays are inert. Terminal run,
  checkpoint, and event truth and non-recursive/leakage assertions remain
  unchanged.
- Verification for that follow-up: `pnpm check` passes 943 unit assertions;
  explicit contract generation/check reports no drift; the complete disposable
  database matrix passes 262 assertions in 34.95 seconds. Isolated worker files
  pass 18 assertions with four intentional skips: the complete coordinator file
  passes 9 in 94.00 seconds, transport passes 5 in 4.52 seconds, and preview
  passes 4 with one intentional skip. The shared destructive transport matrix
  passes one assertion in 16.70 seconds, including PostgreSQL/Redis restart,
  zero claims after drain, 0.36 ms dispatcher close, and 64.62 ms forced active-
  consumer close. Running destructive and ordinary worker files concurrently was
  intentionally rejected as evidence because a service stop disrupts parallel
  fixtures; reruns used isolated sequencing and disposable database/Redis DBs.
  The direct blocked in-flight destination case now fences both coordinator-
  created provider intents, blocks both adapters, and aborts them within the
  shutdown bound. Slack persists `outcome_unknown` and receives no replay; email
  persists unresolved retry truth and later succeeds with the same binding and
  idempotency key. The production dispatcher rejects readiness, claims zero rows
  after drain, and closes within two seconds. The focused destructive assertion
  passes in 82.16 seconds. Destination delivery and consumer gates are complete;
  the all-trigger pinning gate remains open until Webhook and Schedule use the
  shared resolver, so Phase 6 remains in progress. No commit or push was made.
- Destination-disable review fixes on 2026-08-25 make the destination lifecycle
  an operational provider-byte fence without rewriting accepted identity. Load
  and the final fence require `enabled`; a narrowly executable security-definer
  function locks active workspace then destination while preserving worker
  least privilege. Executable races prove disable-first blocks an in-flight
  fence until commit and then rejects it, while fence-first persists
  `dispatching` before a later disable. Accepted run/intent pins and audit truth
  remain intact, and connection disable/rotation continues to fail closed.
- Focused provider-delivery tests pass 25 assertions for Slack/email disable
  before load and between credential load and final fence, returning bounded
  definite pre-dispatch results with zero provider bytes. Six direct Nest API
  seam assertions cover get, append success, optimistic/idempotency conflicts,
  policy set/clear exact replay metadata, and hidden not-found behavior. Root
  `pnpm check` passes formatting, builds, lint, contract drift, typechecks, and
  951 unit assertions. The fresh coordinator PostgreSQL regression passes, the
  changed disposable database files pass 39 coordinator and 15 connection
  assertions, and the enabled real PostgreSQL/Redis/BullMQ provider-adapter
  recovery assertion passes in 82.27 seconds. The broad reusable-database
  command still reproduces only the known `0012` checksum mismatch in ten
  shared suites; its seven disposable suites pass 95 assertions. Docker reports
  PostgreSQL, Redis, and artifact-store healthy. Commits `0cef4f6` and
  `99e6989` record the implementation and disable-fence correction.
- Final Standards follow-up keeps the provider-neutral delivery capability as
  the sole public seam while moving Slack and email credential parsing,
  provider dispatch, classification, and secret cleanup into private
  provider-specific functions. One browser-safe workflow-model schema now owns
  destination configuration below both HTTP contracts and persistence; the
  destination store parses persisted JSON through it and returns a discriminated
  `channelId`/`toEmail` union, so invalid provider-target combinations cannot
  cross the database seam. Public destination use cases have named input and
  return contracts, and destination creation/version append share one private
  immutable-version insertion path. Root `pnpm check` remains green with 952
  unit assertions; focused disposable connection and coordinator suites pass all
  54 assertions in 13.29 seconds. `git diff --check` passes.

## Phase 7 — Production Operations

Status: **In progress**

Authority and production policy:

- [x] Accept ADR 013 before destructive retention, workspace purge, legal-hold,
      or backup-erasure implementation.
- [x] Accept ADR 015 before production launch, fixing the initial SLO, RPO/RTO,
      hosting-region, backup, failover, and regional-recovery strategy.
- [x] Record operated legal authority, backup rotation, data minimization, and
      production retention policy inputs without claiming legal certification.
- [x] Accept ADR 027 before moving tenant-facing deletion and restore off direct
      PostgreSQL mutation, fixing asynchronous intent dispatch and credentials.

Retention, deletion, and legal hold:

- [x] Wire the dedicated maintenance database credential and migration role
      substitution without granting maintenance ownership or serving-role access.
- [x] Implement the external append-only control-ledger adapters, ordered
      PostgreSQL projection, exact high-water reconciliation, and
      restore-before-serve gate.
- [ ] Prove the append-only dual-region ledger and restore-before-serve gate
      against the production AWS accounts, regions, IAM roles, and Object Lock
      configuration.
- [x] Add audited legal-hold placement/release and ensure active holds pause only
      covered destructive work without reactivating tenant access.
- [x] Implement bounded, idempotent, resumable retention batches with durable
      progress, lease fencing, dry-run support, and bounded telemetry.
- [x] Enforce 30-day detailed execution/input/artifact retention, 90-day run and
      trigger-summary retention, seven-day preview retention, and 365-day
      audit/security retention in dependency-safe order.
- [x] Rebuild workspace deletion/restore commands around the external ledger,
      revoke access and triggers, cancel work, and preserve the 30-day recovery
      window before purge.
- [x] Purge every V1 in-scope tenant row, object byte/metadata surface, secret
      version, and index explicitly; persist retryable partial progress and a
      non-sensitive completion tombstone. API-key and connected-subscription
      entities remain plan-deferred and are not invented for deletion.
- [ ] Prove deletion, legal-hold, recovery-window, purge, and regional object
      behavior through the production AWS deployment and its immutable
      invocation evidence.

Operator recovery and observability:

- [x] Add authenticated, authorized, audited, reason-required operator commands
      for outbox redispatch, expired-lease reconciliation, due-work resume,
      unknown-outcome evidence, cancellation, replay, trigger reconciliation,
      and retention/purge reruns; support dry-run where safe.
- [x] Complete cardinality-safe API, PostgreSQL, queue, worker, trigger, provider,
      artifact, retention, purge, and control-ledger metrics.
- [x] Add repository-owned dashboards and user-impact/backlog-age alerts for
      API, queues, workers, triggers, PostgreSQL, Redis, object storage, and
      destructive maintenance.
- [ ] Deploy those dashboards and alerts and capture pager-routing evidence for
      API, queues, workers, triggers, PostgreSQL, Redis, object storage, and
      destructive maintenance.
- [x] Encode and deterministically validate non-root production images, separate
      API/worker commands and health checks, release-job migrations, read-only
      filesystems where possible, and secret-manager-only credential references.
- [ ] Prove the rendered image, task-role, filesystem, migration-job, health, and
      secret-manager boundaries in the production deployment.
- [x] Configure declarative separate API and worker autoscaling inputs against
      admitted load, latency/saturation, oldest-job age, active slots, and
      resource safety.
- [ ] Deploy and measure the separate API and worker autoscaling policies under
      representative admitted load and saturation.

Release exercises and completion gates:

- [ ] Run webhook bursts, large fan-out, long-wait, and noisy-tenant load tests
      against the engineering envelope and prove fair admission under saturation.
- [ ] Run Redis-loss, PostgreSQL-failover, provider-outage, worker-drain, and
      object-storage failure exercises without contradictory durable truth.
- [ ] Run backup/PITR and regional restore drills, reconcile the control ledger
      before tenant traffic, and measure the five-minute RPO and 24-hour RTO.
- [x] Run root checks, dependency/security scans, zero/prior-head migrations,
      complete real-service/recovery matrices, and production-build verification.
- [x] Resolve every blocker/high finding from independent fixed-head Spec and
      Standards reviews and push every coherent implementation/evidence commit.

Current evidence:

- Accepted ADR 015 fixes AWS `eu-central-1` as the multi-AZ primary region,
  `eu-west-1` as the warm regional-recovery target, RDS PostgreSQL Multi-AZ plus
  an encrypted cross-region replica, synchronous immutable dual-region control
  records, 99.9% monthly eligible-request availability, a five-minute
  PostgreSQL/object-storage RPO, and a 24-hour regional RTO. The ADR defines the
  separate availability/latency SLIs, capacity-shedding treatment, replica-lag
  and dual-object-write admission fences, exact recovery dependency order,
  audited traffic cutover, failback direction, and dual-ledger restore agreement
  while leaving implementation and drills open.
  `docs/operations/production-data-policy.md` records the selected 35-day
  recovery-eligibility limit and asynchronous physical-deletion evidence,
  covered backup surfaces, V1 retention and minimization defaults, accountable
  legal-owner approval plus separate legal-administrator execution, quarterly
  access review, backup-beyond-use behavior, and restore-before-serve rule
  without claiming legal certification.
- The tenant-artifact module now places regional replication behind one narrow
  store interface. Server writes persist to Frankfurt, stream the verified bytes
  to Ireland, and checksum-validate both copies before returning metadata that
  can be finalized in PostgreSQL. Direct uploads remain primary-region signed
  but validation synchronously copies and verifies recovery bytes before it can
  succeed. Exact retries repair ambiguous partial replication; conflicting bytes,
  shared bucket/region/principal configuration, unequal purge outcomes, or either
  missing replica fail closed. Worker and retention production configuration now
  require both regional stores, and deployment rendering carries their separate
  configuration and Secrets Manager inputs. The artifact-store suite passes 138
  unit assertions and three real S3-compatible assertions, including a dual-store
  write/verify/read/delete path. Live AWS bucket versioning and regional isolation
  remain deployment evidence rather than repository claims.
- Migration `0068_restore_artifact_inventory.sql` gives only the maintenance role
  a bounded, ordered, read-only function over finalized `available` artifact
  metadata; it grants no tenant-table access. Restore-before-serve now proves both
  artifact buckets are regionally isolated, pages that PostgreSQL inventory under
  explicit bounds, checksum-validates every primary and Ireland replica, records a
  deterministic inventory digest, and refuses to return success on a missing,
  conflicting, non-progressing, or over-bound inventory. Recovery configuration,
  ECS rendering, cleanup, and tests include both artifact stores. The focused
  database upgrade tests applied migrations through `0068`, verified bounded
  pagination through the real maintenance credential, retained denial of direct
  `app.artifacts` access, and passed alongside the 10 recovery assertions.
- Lifecycle-command startup now validates PostgreSQL 18, migration head `0068`,
  the exact lifecycle login, non-membership in owner/worker roles, the complete
  function-only command surface, and denial of direct protected-table access
  before it validates both ledgers or claims work. Only then does it create the
  ECS readiness marker, which is removed before startup and during every cleanup;
  the task health check requires that marker and a live process. Lifecycle and
  retention now share one tested abortable-delay primitive instead of carrying
  separate polling implementations. The focused lifecycle database suite passes
  six real PostgreSQL assertions. The complete repository gate passes formatting,
  all builds, lint, contract drift, typechecks, and 1,227 unit assertions. A clean
  disposable-database integration run passes 366 assertions: five S3-compatible
  artifact/MinIO controls, 330 PostgreSQL assertions through migration `0068`, 24
  worker assertions, and seven API assertions. Three AWS-only control-ledger
  assertions and two separately gated API resilience/rollout assertions remain
  intentionally skipped in that local run. CI now supplies both primary and
  recovery artifact-store identities and buckets to exercise the dual-region path.

- The first Phase 7 checkpoint exposes `DATABASE_MAINTENANCE_URL` through a
  dedicated conservative pool parser, makes `POSTGRES_MAINTENANCE_USER` an
  explicit required migration boundary, and renders `{{maintenance_role}}` for
  reviewed migrations. The migration runner grants this role only visibility of
  the migration ledger needed for compatibility checks; it does not grant
  application-table access, ownership, or serving-role membership. Existing
  migration fixtures now name the maintenance role explicitly. Database
  production/test typechecking passes, all 81 database unit assertions pass, and
  root project typechecking passes. A fresh PostgreSQL 18 database applied all
  44 migrations through `0043`; the real maintenance login read all 44 migration
  records while remaining `NOSUPERUSER`, `NOBYPASSRLS`, and unable to select
  `app.workspaces`. The disposable database was dropped. No retained tenant data
  is deleted by this checkpoint.
- Migration `0044_retention_control_foundation.sql` adds only non-destructive
  local control-plane foundations: a generic ordered workspace-control
  projection schema and high-water fields, workspace-wide legal holds with
  immutable linked audit facts, and durable dry-run-only retention batch
  progress with bounded leases and fencing. New-workspace high water is forced
  to the empty state by a database trigger. The due run-input index and cursor
  both use workspace, expiry, and row identity order. Batch starts require a
  bounded requester and reason, canonicalize required strings, reject
  non-dry-runs, and append exactly one existing `audit_events` fact on exact
  replay. There is deliberately no standalone destruction guard or destructive
  function: a future checkpoint must combine ledger freshness, hold checks,
  lease fencing, and mutation atomically before any deletion authority exists.
  Maintenance, API, worker, and dispatcher roles have no DML privilege on the
  new tables; maintenance can execute only the four narrow projection and batch
  functions. Exact `0043` -> `0044` PostgreSQL 18 testing covers forged API
  inserts, concurrent workspace-lock serialization, exact replay and conflict
  handling, repeated release, sequence/hash failures, immutable relational
  linkage, dry-run audit/progress, lease reclaim and stale fencing, monotonic
  expiry cursors, and expanded unchanged tenant-data snapshots. The dedicated
  exact `0042` -> `0043` suite remains independently green. Because Pertexo has
  not launched, the workspace-first partial index is intentionally created
  non-concurrently and `0044` must land before production data; this is not an
  online-upgrade claim. A fresh zero-to-`0044` PostgreSQL 18 database passes the
  complete 291-assertion database integration matrix across 22 files in 43.60
  seconds; focused exact-head testing passes five assertions and every
  disposable database is dropped. Root `pnpm check` passes formatting, builds,
  lint, generated-contract drift, typechecks, and 1,023 unit assertions. Final
  PostgreSQL/security and Spec re-reviews report no blocker, high, or medium
  findings, and PostgreSQL, Redis, and the artifact store remain healthy.
  External object-ledger I/O and freshness reconciliation, restore-before-serve
  gating, destructive retention/purge, telemetry, and policy enforcement remain
  open, so no broader Phase 7 checklist item is marked complete.
- Migration `0051_workflow_run_input_retention_dry_run.sql` makes the existing
  `workflow_run_input` dry-run control executable without introducing tenant-data
  mutation. Maintenance-only functions claim at most 25 batches with
  `FOR UPDATE SKIP LOCKED`, reclaim expired leases with monotonic fences, and
  inventory at most 1,000 due inputs per keyset page. Every page validates the
  live token, fence, and database-time lease, holds the batch and workspace rows,
  and atomically advances its cursor and counts; completion clears the lease and
  appends one bounded audit event in the same transaction. API, worker,
  dispatcher, and lifecycle-command roles cannot execute either new function
  and the maintenance role still has no direct workflow-run table privilege.
  The new no-HTTP `@pertexo/retention` process parses only maintenance database,
  bounded lease/page/polling, and observability configuration; proves exact role,
  migration head, function grants, and direct-table denial before claiming;
  supports abortable SQL and signal shutdown; drains completed work; emits only
  bounded mode/kind/outcome metrics; and closes database and telemetry resources
  on success or failure. Four focused executable assertions pass. A clean
  zero-to-`0051` PostgreSQL 18 matrix passes all 307 assertions across 25 files;
  focused real-service tests prove exact batch replay, two-page cursor progress,
  exact due counts, unchanged tenant payloads, one completion audit fact, stale
  fence rejection, and API execution denial. Root `pnpm check` passes formatting,
  production builds, lint, generated-contract drift, typechecks, and all 1,163
  unit assertions. Non-dry-run starts remain rejected and migration `0051`
  contains no workflow-run update/delete statement, so destructive retention,
  legal-hold gating, ledger-freshness gating, and the broad retention checklist
  item remain open.
- Migration `0052_workflow_run_input_retention_enforcement.sql` adds the first
  destructive ADR 013 data class without granting serving roles tenant-data
  mutation. Destructive batch starts reject future cutoffs and preserve exact
  idempotency material. Claims are lease/fence bounded and legal-hold pauses are
  durable: a paused batch has no live lease, records only the bounded
  `legal_hold` reason, and becomes claimable after release. The coordinator
  acquires the workspace control lock before any external read and keeps that
  PostgreSQL transaction open while the dual-region ledger proves identical,
  exact high water with no unprojected record. Ledger outage, divergence, newer
  records, changed projected high water, timeout, or page-bound exhaustion rolls
  back the page and releases the batch for retry. With exact evidence and no
  active hold, one maintenance-only function clears `input_ref` and
  `input_ref_expires_at` for at most 1,000 ordered due runs, advances the durable
  cursor/counts in the same transaction, preserves the run summary, and appends
  one bounded completion audit event. A hold placement and destructive page
  serialize on the same workspace row. The no-HTTP retention process now proves
  dual-ledger readiness before claiming and emits separate bounded dry-run and
  enforcement outcomes. Focused real PostgreSQL tests prove two-page deletion of
  exactly three due inputs, preservation of the non-due summary/input, exact
  high-water verification, unchanged payload on ledger-ahead release, durable
  hold pause with unchanged payload, stale fencing, and API denial. A clean
  zero-to-`0052` PostgreSQL 18 matrix passes all 309 assertions across 25 files;
  root `pnpm check` passes formatting, production builds, lint,
  generated-contract drift, typechecks, and all 1,165 unit assertions. Scheduled
  batch creation, the other 30/90/365-day data classes, preview hold coordination,
  artifact-byte deletion, workspace purge, and real AWS Object Lock evidence
  remain open, so the broad retention and purge checklist items stay unchecked.
- Migration `0053_preview_retention_enforcement.sql` moves seven-day preview
  destruction out of the ordinary BullMQ worker and into the no-HTTP
  `@pertexo/retention` process. New previews no longer create cleanup outbox
  events, legacy cleanup events/receipts are retired during migration, the worker
  build no longer advertises or routes the cleanup capability, and the worker's
  legacy privileged completion grant is revoked. A trigger rejects API/worker
  transitions of preview-owned artifacts into `deleting` or `deleted`; only
  maintenance-only discovery, preparation, object checkpoint, and final cleanup
  functions can set the guarded transition. Discovery excludes active holds and
  is bounded to 25 candidates. Each destructive transaction locks the workspace
  control row, requires the exact dual-region ledger sequence/hash with no
  unprojected record, rechecks expiry, terminal status, child previews, and legal
  holds, then advances at most one artifact. A first pass durably marks the
  artifact `deleting`; only a later quiescent pass performs idempotent object
  deletion and confirms absence with `HEAD` while retaining the workspace lock.
  Metadata checkpoint and optional preview/link/attempt/expired-idempotency
  removal commit under that same lock. A crash after object deletion retries the
  same object safely. Tenant artifact credentials are parsed separately from
  both control-ledger principals, artifact and ledger readiness fail before work,
  bounded preview outcomes are emitted, and every database, ledger, artifact,
  and telemetry resource closes on shutdown. Disposable PostgreSQL tests pass 20
  preview authority/execution assertions, the exact prior-preview migration
  assertion, and all 10 control-ledger coordination assertions; `pnpm check`
  passes formatting, production builds, lint, generated-contract drift,
  typechecks, and all unit tests. Scheduled workflow-input batch creation, other
  30/90/365-day classes, general run-artifact retention, workspace purge, and
  real AWS Object Lock evidence remain open, so the broad retention and purge
  checklist items stay unchecked.
- Migration `0054_workflow_run_input_retention_scheduling.sql` makes the proven
  30-day workflow-input enforcement automatic without adding cron or serving-role
  authority. Every workspace has one durable daily scan cursor, including an
  upgrade backfill and trigger provisioning for new workspaces. One
  maintenance-only database call uses PostgreSQL time, claims at most 25 due
  cursors with `FOR UPDATE SKIP LOCKED`, and atomically advances each cursor. It
  creates an audited, date-keyed destructive batch only when expired input exists,
  no destructive batch is unfinished, and the same UTC schedule period was not
  already created. A failed transaction leaves both cursor and batch creation
  retryable; concurrent processes cannot claim the same cursor; restart scans do
  not duplicate batches or audit facts. The no-HTTP retention process schedules
  before enforcement, drains saturated 25-workspace scans without polling delay,
  and emits only fixed-cardinality scanned/scheduled telemetry. Readiness requires
  the narrow function grant and rejects direct schedule-table authority; API,
  worker, dispatcher, and lifecycle-command roles cannot execute the function or
  read its state. A fresh PostgreSQL 18 focused suite passes five assertions,
  including 26 workspaces split across concurrent claims, exact restart replay,
  future cursor advancement, and API denial. The complete disposable database
  matrix passes all 311 assertions across 25 files at head `0054`; root
  `pnpm check` passes formatting, all production builds, lint, generated-contract
  drift, typechecks, and all 1,161 unit assertions. Other 30/90/365-day classes,
  general run-artifact retention, workspace purge, and real AWS Object Lock
  evidence remain open, so the broad retention and purge checklist items stay
  unchecked.
- Migration `0055_standard_retention_classes.sql` extends the same durable daily
  scheduler and fenced no-HTTP maintenance process to 30-day execution detail,
  90-day run and trigger summaries, and 365-day audit/security facts. Each
  workspace now has one cursor per retention kind; scheduling and destructive
  claims remain bounded to 25, destructive pages remain bounded to 1,000 rows,
  expired leases are reclaimable, and execution-detail deletion advances through
  attempt, node-run, event, checkpoint, and summary stages without trusting one
  unbounded cascade. Run-summary deletion waits for retained webhook/schedule
  references, and ordinary audit/security expiry does not touch the separately
  immutable retention-control ledger facts. Every destructive page still holds
  the workspace control row, requires exact dual-region sequence/hash agreement,
  and pauses under legal hold. Serving roles receive no direct table or function
  destruction authority.
- The same migration adds general run-artifact retention to the standalone
  maintenance process. Due available artifacts are rechecked against retained
  run inputs/outputs, node values, attempt reconciliation, events, checkpoints,
  and preview ownership. Referenced artifacts receive a bounded retry time;
  unreferenced artifacts transition under the workspace/ledger lock, are deleted
  idempotently from object storage, and lose PostgreSQL metadata only after a
  confirming `HEAD` observes absence. A failed absence check restores the
  available state with a bounded retry time so later candidates are not starved;
  a crash rolls the transaction back so restart repeats physical deletion safely.
  Database triggers take shared locks for artifact references written to every
  retained run, node, attempt, event, and checkpoint JSON surface, fencing a
  concurrent reference commit against the retention row lock.
  Fixed-cardinality telemetry distinguishes every standard kind and run-artifact
  outcomes. Focused PostgreSQL 18 testing passes seven assertions covering
  one-row staged execution cleanup, 90-day run and schedule-occurrence deletion,
  365-day audit/security deletion, reference extension, object-delete restart,
  non-starving object deferral, concurrent reference locking, exact metadata
  ordering, scheduler concurrency/restart, stale fencing, exact ledger
  agreement, legal hold, and serving-role denial. Standard-class dry-run
  inventory and supported operator rerun commands remain open, so the generic
  retention-batch checklist stays unchecked; workspace purge is also separate.
  A clean zero/prior-head PostgreSQL 18 matrix passes all 313 assertions across
  25 integration files at migration head `0055`. Root `pnpm check` passes
  formatting, production builds, lint, generated-contract drift, typechecks,
  and all 1,163 unit assertions.
- Migration `0056_workspace_purge_foundation.sql` adds one durable purge job per
  due workspace and a separately lease-fenced destructive-step journal without
  deleting tenant data. The maintenance-only coordinator locks the workspace,
  requires exact dual-ledger agreement, persists a stable `purge_started` command
  identity before append, projects the command, and leaves the workspace visibly
  `purging` with an incomplete `tenant_rows` step. Active holds prevent step
  claims, stale leases cannot mutate progress, serving and lifecycle-command roles
  receive no purge authority, and `deletion_completed` is rejected until all
  registered steps complete. Retry reconciliation accepts only the durable job's
  own agreed ledger tail, repairing an append-success/projection-crash without a
  second append; ordinary concurrent claim loss returns idle rather than stopping
  retention processing. Focused PostgreSQL testing passes two end-to-end
  assertions including ambiguous append repair and a two-coordinator race, and
  a clean zero/prior-head PostgreSQL 18 matrix passes all 315 assertions across
  26 integration files, and the 115 database unit assertions plus all six
  retention assertions/typecheck remain green. Tenant
  rows, object versions, secret versions, indexes, and retained-fact minimization
  are deliberately not implemented by this foundation, so workspace purge and
  deletion-completion checklist items remain open.
- Migration `0057_workspace_tenant_rows_purge.sql` implements the `tenant_rows`
  step as one dependency-ordered page per maintenance transaction. Every page
  rechecks the exact external-ledger high water, active legal holds, workspace
  state, and lease token/fence before deleting at most 500 ordinary rows; the
  three deferred current-version parent/child units affect at most 500 parents
  plus their current immutable versions. Immutable history triggers admit delete
  only while the live purge lease token is transaction-locally armed. The step
  removes V1 tenant data and encrypted secret-version rows, minimizes retained
  audit, usage, and transport-security facts, preserves the workspace/control/
  legal-hold/purge tombstone surfaces, and fails closed if a new `workspace_id`
  table has residual rows. The retention process now drives these pages through
  the same maintenance-only exact-ledger coordinator and treats legal-hold or
  concurrent-claim loss as idle. Focused end-to-end tests cover hold blocking,
  lease fencing, coordinator-driven completion, retained-fact minimization,
  residue detection, and denial of premature `deletion_completed`; a fresh
  zero/prior-head PostgreSQL 18 matrix passes all 315 assertions across 26
  integration files, while all 116 database unit and six retention assertions
  pass with root builds, contract drift checks, and typechecks. Object bytes and
  every S3 version/delete marker remain a separate step, so the broad purge and
  deletion-completion checklist stays open.
- The artifact store now exposes a purge-only bounded workspace-prefix operation
  using `ListObjectVersions` and explicit-version `DeleteObjects`. Each call
  lists at most 500 entries from the first page under the exact
  `workspaces/{workspaceId}/` prefix, validates every key/version pair, deletes
  object versions and delete markers, rejects duplicate, malformed, foreign,
  over-bound, empty-truncated, or partially failed provider responses, and
  reports completion only after a fresh empty list. Repeated first-page scans
  make a crash after physical deletion safe without persisting invalidated S3
  continuation markers. All 126 artifact-store assertions pass.
- Migration `0058_workspace_object_versions_purge.sql` adds and backfills an
  `object_versions` purge step, resets pre-migration tenant leases, claims exactly
  one step, and prevents `tenant_rows` from being claimed before object erasure
  completes. Its maintenance-only checkpoint rechecks the live token/fence,
  workspace lock, exact ledger anchor, and legal hold after S3 I/O. Final deletion
  now explicitly requires both named steps, rather than trusting absence of an
  unregistered row. The retention coordinator holds the workspace transaction
  lock across bounded object I/O, establishes tenant context before artifact
  metadata deletion, and safely retries an ambiguous delete-before-checkpoint.
  Focused tests cover object-before-metadata ordering, hold exclusion, stale
  checkpoint rejection, two-step completion, and ambiguous physical-delete
  recovery. A fresh zero/prior-head PostgreSQL 18 matrix passes all 316 assertions
  across 26 integration files; all 117 database unit and six retention assertions
  also pass. The local tenant S3Mock does not provide credible version/delete-marker
  proof and the control-ledger MinIO buckets intentionally deny deletion, so live
  version-enabled bucket evidence stays open.
- Migration `0059_workspace_purge_completion.sql` persists a separate stable,
  lease-fenced `deletion_completed` command only after both required purge steps
  are complete and no legal hold exists. The coordinator performs exact-ledger
  reconciliation before preparation and again while holding the workspace lock,
  repairs append-success/result-loss without a duplicate append, marks the purge
  job completed before the guarded workspace projection in the same transaction,
  and records a projected completion journal. The surviving workspace row is
  reduced to its ID, lifecycle timestamps/anchors, deterministic deleted name and
  slug, generic `purged` reason, and null creator/request-actor references; legal
  control-ledger facts remain intact. Focused PostgreSQL tests verify ambiguous
  completion recovery, final guard ordering, and the minimized tombstone. All 118
  database unit assertions pass, and a fresh zero/prior-head PostgreSQL 18 matrix
  passes all 316 assertions across 26 integration files; live provider
  version-erasure evidence remains the only open workspace-purge proof.
- Migration `0060_standard_retention_dry_run.sql` extends dry-run inventory to
  execution detail, run summaries, trigger summaries, and audit/security facts.
  Execution-detail inventory counts due run envelopes rather than walking an
  unbounded number of child rows; enforcement retains its dependency-safe child
  stages and reports their actual progress separately.
  When each stage begins it freezes one typed JSONB upper tuple; resumable typed
  cursors remain bounded by that stage high water and reset at stage transition.
  Only the active stage is queried, using native typed row comparisons, supporting
  keyset indexes, and a hard page-plus-one limit. Pages return explicit
  `progressed`, `completed`, or `stale` outcomes, validate the lease token/fence
  and expiry under the batch lock, and separately count examined candidates and
  currently eligible effects. Rejected run/delivery candidates advance the
  cursor, while delivery eligibility models the preceding expired-replay cleanup
  without mutating it. Pages update only retention control progress and completion
  audit facts. The
  maintenance process dispatches by explicit retention kind while omitted kinds
  retain the existing `workflow_run_input` API default. The bounded stage helper
  is internal, and serving and lifecycle-command roles cannot execute either it
  or the maintenance page. Page-size-one testing proves stage and empty-stage
  progress, lease reclaim without duplicate counts, frozen-upper deferral, stale
  fencing, and unchanged source rows. Inventory is intentionally weakly
  consistent across transactions: rows inserted or made eligible behind a
  committed cursor are deferred to a later batch rather than presented as part
  of a point-in-time snapshot. All 119 database unit assertions and seven focused
  disposable-PostgreSQL retention assertions pass; a clean zero/prior-head
  PostgreSQL 18 matrix passes all 316 assertions across 26 integration files at
  migration head `0060`. Supported operator rerun commands remain open, so the
  broad retention-batch checklist stays unchecked.
- Migration `0061_operator_outbox_redispatch.sql` and the separate
  `@pertexo/operator-command` one-shot executable implement ADR 029's first
  supported command without an HTTP listener, queue consumer, tenant credential,
  or direct table grant. `pertexo_operator` can execute only the command-specific
  redispatch and status functions. Both one-shot modes require a bounded actor
  reference, durable UUID, workspace/outbox target, explicit dry-run choice, and
  reason; status prints the bounded durable result and audits the lookup without
  requiring ad hoc SQL. PostgreSQL computes and persists the canonical fingerprint before any
  mutation, serializes concurrent command-ID reuse, returns exact replay, rejects
  conflicting replay, and appends one workspace audit event. Dry-run records the
  prior failed timestamp/error/attempt count without changing transport state.
  Execution preserves immutable outbox identity/payload/checksum, clears only the
  failed lease lifecycle, resets the exhausted attempt budget, and returns the row
  to normal fair dispatcher admission. Focused real-role PostgreSQL integration
  passes 22 transport assertions, including normal dispatcher reclaim and
  concurrent exact replay, and 121 database unit assertions plus four executable
  assertions pass. Database readiness, status, and mutation run with
  server-enforced lock/statement timeouts; resource cleanup has an independent
  bound. A fresh zero/prior-head PostgreSQL 18 matrix passes all 319 assertions
  across 26 integration files at migration head `0061`. The ECS contract
  models this as a no-health-check job with only `DATABASE_OPERATOR_URL` in Secrets
  Manager. Local/CI identity and role proof is not production authentication or
  IAM/admission evidence. Fresh clusters create the no-membership role during
  bootstrap; pre-`0061` clusters have an explicit idempotent
  `db:provision-operator` prerequisite that must run through their authenticated
  database-provisioning path before release migration. The broad operator-command checklist remains unchecked
  until the other recovery commands are supported.
- Migration `0062_operator_command_ledger.sql` broadens the bounded,
  function-only command ledger and status projection for the remaining ADR 029
  command types without granting generic table authority or retaining tenant
  request material beyond the normal workspace audit lifecycle. Existing
  redispatch status remains compatible, and zero/prior-head migration coverage
  includes the new ledger head. No additional recovery mutation authority is
  introduced by this foundation checkpoint.
- Migration `0063_operator_execution_recovery.sql` adds four narrow synchronous
  ADR 029 commands: dry-runnable expired-attempt reconciliation, dry-runnable
  due-work resume, append-only unknown-outcome evidence, and dry-runnable run
  cancellation. The shared dispatcher is owner-only; `pertexo_operator` can
  execute only typed wrappers and has no direct command, evidence, execution,
  outbox, or audit table authority. Reconciliation preserves fence and
  side-effect-class rules, unknown evidence cascades with the tenant attempt,
  and resume/cancellation emit the normal identifier-only coordinator wakeup.
  Unknown-outcome evidence emits a dedicated identifier-only maintenance wake;
  its checksum-bound consumer completes one durable inbox receipt while leaving
  immutable attempt, node, and run outcomes unchanged. Due-work processing is
  capped at 100 nodes per command and reports whether another command is needed.
  Focused PostgreSQL integration passes 24 execution-runtime assertions,
  including positive mutation, dry-run, exact replay, and append-only evidence
  paths. Run replay, trigger reconciliation retry, and retention/purge reruns
  remain open, so the broad operator-command checklist stays unchecked.
- Migration `0064_operator_trigger_reconciliation.sql` adds the narrow,
  dry-runnable `trigger.reconcile` command. It locks the active workflow,
  captures its current published version, and requests a fresh normal
  `reconcile-workflow-triggers` delivery without mutating trigger projections or
  granting trigger-table authority to `pertexo_operator`. Exact command replay
  returns the original outbox identity, conflicting reuse is rejected, and the
  existing trigger worker remains the sole reconciliation authority. Run replay
  and maintenance-owned retention/purge reruns remain open.
- Migration `0065_operator_run_replay.sql` adds asynchronous `run.replay` with
  an explicit source run, pinned workflow version, and bounded explicit input.
  The operator records only a durable request and identifier-only
  `replay-workflow-run` outbox event; a normal worker verifies the outbox/inbox
  identity and executable compatibility, creates a fresh initial checkpoint,
  admits a new run through the standard quota/outbox path, and atomically stores
  immutable source-run and command lineage. Dry-run inventories eligibility,
  exact request replay is stable, conflicting command reuse is rejected, and
  asynchronous status moves from `pending` to `completed` or `failed` without
  granting the operator table authority. Maintenance-owned retention/purge
  reruns remain open.
- Migration `0066_operator_maintenance_rerun.sql` completes the repository-owned
  command family with bounded `retention.rerun` and `purge.rerun` wake requests.
  Operators can inventory or durably request one named batch/job but receive no
  maintenance-table authority. The retention executable consumes at most one
  request per poll, classifies active leases, legal holds, completed work, and
  reclaimable targets under `pertexo_maintenance`, then invokes the unchanged
  lease-, ledger-, hold-, and page-fenced coordinators in the same cycle. The
  broad checklist remains open until approved production IAM admission and
  immutable invocation evidence are captured.
- Migration `0067_reconcile_published_migration_repairs.sql` repairs the release
  compatibility break caused when corrections were folded into already-pushed
  migrations `0037` and `0038`. The runner accepts only the four exact published
  legacy checksums, retains fail-closed rejection for every unknown checksum,
  and applies one idempotent forward migration that converges the notification
  dispatch fence, admission reservations, recovery identities, policies, grants,
  and unbounded recovery counter. A disposable PostgreSQL upgrade deliberately
  removed the corrected schema surfaces, recorded the oldest published checksums,
  applied only `0067`, verified the restored table/functions and `bigint` counter,
  and proved an idempotent second migration run. Database unit/type checks pass.
- Accepted ADR 028 defines a repository-owned ECS workload manifest and migration
  release-job contract. The multi-stage production image runs as UID/GID 10001
  under `tini` with production dependencies only. Rendered Fargate definitions
  keep root filesystems read-only with ephemeral `/tmp`, separate API, worker,
  lifecycle-command, retention, recovery, and migration commands, use readiness
  or process/exit health appropriate to each role, and source credentials only
  through Secrets Manager while non-sensitive configuration comes through SSM.
  Static validation rejects plaintext credential placement, combined or missing
  role commands, missing service health checks, and incorrect Frankfurt/Ireland
  API/worker counts. ARM64 and declared `linux/amd64` images built successfully;
  non-root, read-only-root, entrypoint, executable, migration-SQL, and
  production-dependency smoke checks passed. `pnpm deployment:check`, deterministic
  rendering of the workload definitions, focused ESLint, and release-shell syntax pass.
  Actual IAM policies, ECS services, networking, secret delivery, release rollout,
  and the restore gate still require AWS, so the deployment checklist remains
  open rather than treating manifests as production proof.
- The local release/security checkpoint adds a fail-closed
  `pnpm security:audit` production dependency gate and composes it with root and
  quality, deployment, and exercise checks in `pnpm release:check`. CI declares
  dependency, deployment, and exercise validation on pull requests and `main`
  pushes and nightly runs; the manual and weekly release workflow invokes that
  complete real-service/recovery matrix plus the local release gate, a
  production-image build, non-root/read-only smoke, and commit-pinned Grype scan.
  A separate commit-pinned CodeQL workflow covers JavaScript/TypeScript on `main`,
  weekly, and by manual dispatch. Task-definition rendering requires a lowercase
  SHA-256 digest-qualified image, sorts source collections, renders twice, and
  verifies byte identity, workload-specific task roles, non-root users, and
  read-only roots while proving a mutable tag is rejected. Every Node Docker
  stage pins the current Node 24 base digest; the runtime applies current Debian
  fixes and removes unused npm/Corepack binaries. A separately validated
  ADR 030 autoscaling-input contract declares independent Frankfurt/Ireland API
  and worker bounds: API uses p95 request latency and ECS saturation, while
  workers use oldest-waiting-job age and active-handler utilization normalized by
  running task count and the explicit 60-slot-per-task capacity. Local ARM64 production-image
  build and UID 10001/read-only-root smoke pass. Grype `v0.97.1` reports no
  fixable high or critical findings; unfixed findings remain visible for release
  risk review. `pnpm release:check` passes the production dependency audit,
  formatting, all production builds, lint, generated-contract drift, typechecks,
  all 1,194 unit assertions, deterministic deployment checks, and six-profile/five-
  assertion exercise validation. These checks provide no AWS IAM, service, alarm,
  scaling-policy, workflow-execution, deployed-image, or rollout evidence, so the
  deployment, autoscaling, and broad Phase 7 release checklist items remain open.
- A bounded open-loop HTTP exercise runner now provides six validated profiles:
  a 20 starts/second confidence run, a signed 50 webhooks/second five-minute
  burst, pre-provisioned large-fan-out and long-wait workflow starts, and
  separate noisy/control tenant lanes. API mutation profiles send the product's
  session cookie plus double-submit CSRF values; webhook requests generate a
  fresh timestamp and HMAC over the exact raw body. Credentials remain
  environment-only and are absent from evidence. Exact response policy requires
  `202 Accepted`, so `401`, `403`, an unintended `429`, redirects, and other
  client failures cannot pass merely because the server-error ratio is green; a
  future intentional `429` profile must name its stable rate-limit problem code.
  Evidence adds bounded status/problem counts and unexpected-response truth to
  the existing profile/body digests, latency, scheduling, and objective fields.
  Fixture validation rejects unknown fields and profile headers containing
  authentication material. `pnpm exercise:check` passes validation, Node syntax,
  and five focused authentication/signature/response-policy assertions; focused
  ESLint, Prettier, and diff checks pass. No measured load result is claimed
  because an authenticated target and approved exercise tenants were not
  available. HTTP acceptance also does not prove fan-out completion, durable
  waits, or cross-tenant fairness, so all measured load and failure-injection
  release exercises remain open.
- The artifact-store package now exposes a separate append-only ADR 013 control
  ledger adapter and dedicated `CONTROL_LEDGER_*` configuration without changing
  the tenant `ArtifactStore` API or worker artifact configuration. Its principal
  and bucket must be distinct from tenant artifact storage. Records use
  strict unified command contracts, canonical UTF-8 JSON, and SHA-256 over the
  canonical record excluding `recordHash`; every read validates canonical bytes,
  identity, bounds, and the recomputed hash. Fixed zero-padded sequence keys live
  under `control-ledger/workspaces/`, outside `workspaces/` tenant artifact
  prefixes. Conditional `If-None-Match: *` writes provide exact canonical replay
  or a stable content conflict. Append and reconciliation fail closed unless
  `HeadBucket`, a bucket location equal to the configured region, versioning
  `Enabled`, Object Lock `Enabled`, default `COMPLIANCE`
  retention at least as long as the deployment-provided minimum, no lifecycle
  rules, and an unconditional public-principal policy deny for object deletion,
  version deletion, object replication, and replicated deletion are verified for
  that operation. The policy must separately deny
  `PutObject` for the public principal and ledger resource when `If-None-Match`
  is absent, preventing clients from bypassing conditional-create semantics. A
  separate least-privilege ledger principal remains a deployment requirement.
  Writes request SHA-256 checksums,
  validate returned checksums when supplied, and explicitly set COMPLIANCE mode
  plus a retain-until date at the configured minimum. Reconciliation validates a
  nonzero caller anchor, uses one strongly consistent bounded `ListObjectsV2`
  request for at most the requested page plus one key, rejects malformed, foreign,
  or nonconsecutive keys, and distinguishes a page end from proven high water.
  Sixty-three focused memory-S3 tests prove bytes/hash, ordering, replay/conflict
  races, predecessor/anchor corruption, bounded list contracts and external gaps,
  exact not-found handling, cancellation/timeout propagation, dedicated
  configuration, production controls, and explicit client ownership. Package
  build/typecheck and all 94 package unit assertions pass. Adobe S3Mock does not
  provide a credible proof of versioning, Object Lock default COMPLIANCE
  retention, lifecycle absence, and delete/replication-deny bucket policy, so the
  real S3Mock suite continues to prove two tenant artifact I/O assertions only
  and does not run or claim production-readiness proof for the gated
  control-ledger adapter. A real Object-Lock-capable service test remains
  required. The retained S3Mock artifact integration passes both assertions, and
  root `pnpm check` passes formatting, builds, lint, generated-contract drift,
  typechecks, and all 1,089 unit assertions. Final security and Spec reviews
  report no blocker, high, or medium findings. PostgreSQL command projection,
  exact restore reconciliation, and restore-before-serve wiring are still absent,
  so the combined external-ledger checklist item remains unchecked and Phase 7
  remains in progress.
- Migration `0045_control_ledger_command_lock.sql` adds a narrow
  `SECURITY DEFINER` maintenance function that locks one workspace lifecycle row
  for the caller transaction and returns its projected control-ledger high water,
  plus command-id lookup and no-mutation legal-hold transition preflight functions
  executable only by maintenance. Maintenance retains no direct control-table
  privileges. The database package exposes a structural,
  artifact-store-independent legal-hold coordinator over the maintenance pool.
  Placement, release, and one-workspace reconciliation validate bounded inputs,
  cap adapter pages at 100 records, set transaction-local lock and statement
  timeouts while explicitly disabling idle-in-transaction timeout, and hold the
  PostgreSQL row lock through externally timed ledger operations. Reconciliation
  projects and commits one bounded chunk per lock transaction; invocation bounds
  raise a stable error only after completed chunks are durable, so retries resume
  from the advanced database high water. Commands append only after a transaction
  proves external high water, performs exact replay lookup, and validates the
  requested hold transition under the lock. Duplicate placement, absent release,
  and repeated release therefore create no irreversible external records. SQL
  queries receive caller cancellation, pool acquisition releases an eventual
  client after prompt abort, and a dedicated PostgreSQL cancellation request
  interrupts an in-flight lock wait; every cancellation-targeted client is
  destroyed before reuse so a delayed backend cancel cannot affect another query. Exact
  replay, payload conflict, and the append-success/projection-failure crash window
  remain recoverable without duplicate append. Fifteen focused fake pool/ledger
  tests cover ordering, preflight, rollback, cancellation, external timeout,
  replay/conflict, crash recovery, durable bounded progress, command catch-up,
  unsupported commands, pool acquisition, and page limits. Seven PostgreSQL
  integration tests prove the exact `0044` -> `0045` migration, maintenance-only
  execution and NULL/exact-command behavior, lock serialization, invalid-transition
  preflight, append-failure atomicity, external-timeout lock lifetime, in-flight SQL
  cancellation, durable chunk retry, command catch-up, interrupted-append recovery,
  multiple holds, release, and exact sequence/hash advancement. Database
  typechecking and all 98 unit assertions pass. A complete isolated fresh-database
  matrix passes all 298 PostgreSQL assertions across 23 files in 44.84 seconds;
  the temporary database was dropped afterward. Root `pnpm check` passes
  formatting, builds, lint, generated-contract drift, typechecks, and all 1,105
  unit assertions. Final security and Spec reviews report no blocker, high, or
  medium findings. The real Object-Lock-capable service matrix and
  restore-before-serve gate remain open, so the combined external-ledger
  checklist stays unchecked and Phase 7 remains in progress.
- The artifact-store package now exposes the ADR 015 dual-region control-ledger
  facade and dedicated `CONTROL_LEDGER_RECOVERY_*` configuration. Configuration
  requires distinct primary/recovery regions, buckets, and access-key IDs, and
  keeps both ledger buckets separate from tenant artifacts. Readiness runs both
  per-bucket control proofs concurrently, including `GetBucketLocation`, and
  requires distinct service-reported bucket regions before every append, read,
  or reconciliation. Append pre-reads the target sequence in both regions.
  Empty targets receive the same append concurrently; an exact two-sided record
  is replayed without writing; and an exact one-sided record can write only the
  missing side. Different command material cannot fill a one-sided gap. Settled
  append classification distinguishes two conflicts, one-success-plus-conflict
  integrity divergence, and retryable one-success-plus-outage partial
  replication before considering cancellation. Canonical comparisons ignore
  omitted/`undefined` object properties and object property order while retaining
  array order. Reads remain strict. Reconciliation remains strict unless a
  database command reconciliation supplies its current UUID as
  `repairCommandId`; only one matching immediate one-sided tail after an exact
  common page can then expose that common prefix as high water so the normal
  conditional append heals the missing side. Explicit workspace reconciliation
  never enables this path, no record is copied automatically, and divergent or
  unavailable evidence remains fail closed. Owned close attempts both ledgers
  and aggregates failures. The focused tests cover actual-region drift,
  mandatory isolation, canonical optional fields, settled error classes,
  one-sided exact repair, different-command poisoning prevention, strict reads
  and reconciliation, wrapped cancellation, Ireland's legacy `EU` location
  response, and exception-safe ownership. Artifact-store and database unit suites
  pass 122 and 100 assertions respectively; root `pnpm check` passes all 1,135
  unit assertions, and the retained S3Mock tenant-artifact integration passes both
  assertions. Final security and Spec reviews report no blocker, high, or medium
  findings. This remains memory-adapter evidence only: the PostgreSQL coordinator
  does not yet instantiate the facade, restore-before-serve remains absent, and
  S3Mock is not real Object Lock or AWS regional-isolation evidence. Therefore
  the combined external-ledger checklist remains unchecked and Phase 7 remains in
  progress.
- Migration `0046_workspace_deletion_control_projection.sql` adds `purging` and
  protects control-ledger sequence/hash anchors while deliberately preserving
  the existing API lifecycle and deletion-metadata grants. The immutable control
  audit relation now accepts all six command types. A maintenance-only deletion
  projector enforces exact replay and sequence/hash chaining, workspace subject
  identity, NULL deletion legal authority, UUID/existing-user request actors,
  monotonic event-time request/restore/purge/completion ordering, the exact
  default 30-day recovery interval, restore to suspended with cleared metadata,
  completion only from purging, and active workspace-hold blocking. It exposes
  preflight only for future request/restore command creation and no purge command
  creation surface; bounded keyset anchor enumeration is maintenance-only and
  serving roles cannot project or enumerate. The coordinator remains a legal-hold
  command API and now reconciles all six authoritative record types, dispatching
  deletion records only for recovery projection. The existing HTTP
  identity/workspace deletion and restore use cases remain the legacy direct
  PostgreSQL authority and retain their behavior in this additive checkpoint.
  Root `pnpm check` passes all 1,137 unit assertions, and a clean zero-to-head
  PostgreSQL matrix passes all 300 assertions including the exact `0045` ->
  `0046` upgrade and the unchanged legacy deletion/restore API behavior.
  Normal external-ledger deletion command creation, ADR-required session/key/
  trigger/run/provider side effects, API authority migration, destructive purge
  proof, deployment-wide anchor enumeration/reconciliation, and the
  restore-before-serve gate remain open; the combined checklist items above stay
  unchecked.
- Local and CI composition now define two independent, persistent MinIO
  `RELEASE.2025-09-07T16-13-09Z` processes on loopback-only ports 9091 and 9092,
  reporting `eu-central-1` and `eu-west-1` respectively, with separate data
  volumes and credentials. Both processes start healthy, and the gated
  artifact-store integration setup idempotently creates distinct fixed buckets
  with Object Lock enabled, versioning enabled, and 30-day default COMPLIANCE
  retention. CI proves conditional create/replay rejection and unconditional
  deletion denial against both services. The test fixture also retains the
  complete AWS path for the adapter's exact unconditional delete/version-delete/
  replication deny and missing-`If-None-Match` write deny, plus randomized
  append/replay/conflict/one-sided-retry and raw mutation proofs. MinIO accepts the
  replication action names but rejects the required policy with
  `MalformedPolicy: invalid condition key 's3:if-none-match'`. The same result
  was reproduced with `RELEASE.2025-04-22T22-12-26Z`; MinIO supports conditional
  `PutObject` requests but exposes no equivalent bucket-policy condition that
  can enforce the header. Weakening the production adapter or treating Object
  Lock version preservation as overwrite prevention would not prove the
  required control. CI asserts this incompatibility and verifies that adapter
  readiness fails closed rather than bypassing it. This is local S3-compatible
  implementation evidence only, not AWS IAM, AWS regional infrastructure,
  durability, or Frankfurt-to-Ireland recovery evidence. The production AWS/
  Object Lock regional drill and the combined external-ledger checklist remain
  open.
- Commit `edf4dc2` adds maintenance-role readiness and bounded complete-workspace
  reconciliation to the database coordinator. Recovery inventory uses the
  maintenance-only keyset function from migration `0046`, releases each inventory
  client before workspace reconciliation, retries only the coordinator's durable
  record-bound error, restarts every sweep at the beginning, and hashes ordered
  workspace/final-sequence/final-hash tuples. Success requires two consecutive
  complete sweeps with identical count and digest and zero projections in the
  later sweep. Focused tests prove lower-sorting workspace insertion, a command
  arriving between sweeps, bounded non-stabilization, and cancellation. A real
  PostgreSQL 18 disposable database proves the exact maintenance role, migration
  head, function grants, direct-DML denial, and an eight-workspace multi-page
  stable inventory; all 10 focused integration assertions pass.
- The dedicated `@pertexo/recovery` one-shot executable composes the restricted
  maintenance database, dual-region control ledger, telemetry, process timeout,
  and signal cancellation without starting HTTP listeners, Redis, BullMQ, or
  tenant artifact storage. It fails on dependency readiness, regional disagreement,
  reconciliation bounds, interruption, timeout, or any resource cleanup error.
  Configuration is fully parsed before resources open, and seven focused tests
  cover defaults/cross-field bounds, regional isolation, success ordering,
  readiness failure, cancellation, and cleanup failure. Package build, typecheck,
  lint, and tests pass; root `pnpm check` passes all 1,148 unit assertions.
  `docs/operations/regional-recovery.md` fixes the admission
  order: globally fence every writer, recover and migrate PostgreSQL, require a
  fresh successful one-shot job, rebuild Redis, then open workers and API traffic.
  The executable cannot prove that deployment-wide writer fence; no deployment
  manifests or AWS resources exist yet, and MinIO still fails the exact production
  bucket-policy proof. Therefore the combined external-ledger/restore checklist
  remains unchecked and no regional drill or RPO/RTO claim is made.
- ADR 027 keeps maintenance and dual-ledger credentials out of the public API.
  Deletion and restore become durable asynchronous operation resources processed
  by a separate lifecycle-command worker with a request/restore-only database
  role. The decision fixes exact command identity before external I/O, bounded
  lease/fence recovery, under-lock authorization recheck, `202` acceptance,
  exact idempotency replay, a fixed 30-day deadline, and restore-to-suspended
  behavior.
- Migration `0047_workspace_lifecycle_command_intents.sql` and the database
  configuration add a separate `NOSUPERUSER`, `NOINHERIT`, `NOBYPASSRLS`
  lifecycle-command login and a durable tenant-scoped operation resource for
  request/restore intent. The API can create and read only through owner/context-
  checked functions; it cannot read or mutate the table, claim work, project a
  command, or use the command credential. The command role can claim at most 25
  operations with five-minute leases and monotonic fences, release retryable
  work, record bounded terminal failures, and complete only against an exact
  projected command. It can project only request/restore through a fixed 30-day
  wrapper and cannot place holds, start purge, complete deletion, enumerate
  workspaces, or directly mutate control tables. Command identity and occurrence
  time are durable before external I/O, changed idempotency replay conflicts, and
  intent acceptance does not change workspace state. All 106 database unit
  assertions and 13 focused PostgreSQL assertions pass, including exact `0045`
  through `0047` migration, role isolation, absent-context and unauthorized-actor
  rejection, replay/conflict, unchanged pre-projection lifecycle state, lease
  expiry, monotonic fencing, and stale release rejection. Root `pnpm check`
  passes formatting, builds, lint, generated-contract drift, typechecks, and all
  1,149 unit assertions. A clean zero-to-`0047` PostgreSQL matrix passes all 304
  assertions across 24 files in 46.59 seconds; the temporary database was dropped.
  The command executable, under-lock worker authorization recheck, ledger append/
  projection completion, side effects, generated asynchronous API contract,
  deployment, and operational evidence remain open, so no retention/deletion
  checklist item changes status.
- Migration `0048_workspace_lifecycle_command_hardening.sql` closes the
  executable-review findings before any command worker is added. The lifecycle
  role loses the unbound request/restore projector and generic workspace lock,
  command-read, and transition-validation functions. Authorization is now
  durable only for an exact accepted operation after a second active-user/owner
  and current-transition check under the workspace lock. Projection derives the
  workspace, command ID/type, actor, reason, subject, authority, occurrence time,
  and fixed recovery interval from that operation; it requires the exact live
  token/fence and atomically projects, revokes member sessions for deletion, and
  completes the operation. Exact five-minute claims use one database timestamp,
  occurrence time is canonicalized to milliseconds before external I/O, and
  lease expiry independently prevents authorize, release, failure, projection,
  or completion. An already-authorized retry remains able to repair an ambiguous
  append without silently reauthorizing after a credential or deadline change.
  Six focused lifecycle PostgreSQL assertions prove the dropped broad projector,
  exact maximum lease, expiry and stale-fence denial, lost-owner rejection after
  API acceptance, operation-bound projection/completion with session revocation,
  and restore rejection after its deadline; the combined coordinator/lifecycle
  focus passes 16 assertions. All 107 database unit assertions pass. Root
  `pnpm check` passes all 1,150 unit assertions, and a clean zero-to-`0048`
  PostgreSQL matrix passes all 307 assertions across 24 files in 44.37 seconds;
  the temporary database was dropped. Trigger/run/provider side effects, API
  migration, and deployment remain open.
- Commits `c57eb14` and `d66562c` add the operation-bound lifecycle coordinator
  and standalone `@pertexo/lifecycle-command` process. The coordinator claims
  one fenced intent, commits the under-lock authorization decision before
  external I/O, requires exact dual-ledger page-end and high-water evidence,
  enables repair only for the durable operation command ID, verifies every
  returned record field, and atomically projects and completes through the
  migration `0048` function. External calls are bounded even for a
  non-cooperative adapter; caller cancellation reaches pool acquisition, SQL,
  and projection, destroys a cancellation-targeted client, and releases the
  operation for retry before propagating shutdown. A conservative timeout
  budget must fit inside the maximum five-minute lease. Stable lost-owner and
  invalid-transition errors become bounded terminal operation failures, while
  outage, timeout, ambiguous append, and stale ownership remain retryable.
  The real PostgreSQL lifecycle suite proves that an append whose response is
  lost releases the intent, reclaims it with a new fence, discovers the exact
  durable record, and completes once with session revocation and
  `pending_deletion` projection; all six focused assertions pass. The executable
  parses only lifecycle-command database, dual-ledger, polling, timeout, and
  observability configuration; proves both ledgers ready before claiming; opens
  no HTTP, Redis, BullMQ, or tenant-artifact dependency; drains completed work;
  backs off idle/retry outcomes; and closes all resources on signal or failure.
  Its five focused configuration/lifecycle assertions, package build,
  typecheck, and lint pass. Root `pnpm check` passes formatting, all production
  builds, lint, generated-contract drift, typechecks, and all 1,156 unit
  assertions. Trigger/run/API-key/provider cancellation and revocation side
  effects, asynchronous API contract/authority migration, deployment admission,
  and the broader production gates remain open, so no Phase 7 checklist item is
  marked complete by this checkpoint.
- Migration `0049_workspace_deletion_side_effects.sql` moves all currently
  persisted local deletion-request effects to the authoritative workspace
  projection transaction used by both command processing and recovery replay.
  It revokes member sessions, marks active connections as requiring
  reauthorization, disables workflows, webhook/schedule triggers and failure
  notification destinations, clears schedule leases, terminally cancels queued
  runs with matching checkpoint/event state, and records plus immediately wakes
  bounded five-minute cancellation for running/waiting runs. Restore remains a
  suspended-state transition and does not reactivate any integration. Narrow
  active-workspace trigger fences prevent a concurrent connection, trigger,
  schedule, endpoint, or notification mutation from re-enabling an integration
  after deletion projection. Legacy direct lifecycle behavior remains compatible
  until the public API is migrated, including durable canceled-state replay and
  session-revocation counts. Root `pnpm check` passes formatting, all production
  builds, lint, generated-contract drift, typechecks, and all 1,157 unit
  assertions; a clean zero-to-`0049` PostgreSQL matrix passes all 307 assertions
  across 24 files, including deletion racing accepted runs and the
  operation-bound lifecycle projection fixture. Platform API-key entities and
  external provider subscription/revocation dispatch do not yet exist, and the
  public HTTP API still mutates lifecycle state directly, so the deletion
  checklist remains open.
- The public deletion and restore endpoints now implement ADR 027 as
  asynchronous `202 Accepted` commands backed by the durable lifecycle-operation
  table. Exact idempotency replay returns the same operation, changed command
  material returns a conflict, and the new owner-authorized polling endpoint
  exposes only operation identity, command type, state, safe timestamps, bounded
  error code, and a completed workspace reference. It never returns the actor,
  reason, request/key hashes, ledger sequence/hash, lease, fence, or attempts;
  V1 deletion input no longer accepts a caller-selected purge deadline. Migration
  `0050_workspace_lifecycle_api_authority.sql` revokes every API-role workspace
  lifecycle update column while retaining only the unrelated `updated_at`
  authority required by existing PostgreSQL row-locking paths. Readiness proves
  both narrow lifecycle functions are executable and every direct lifecycle
  column is non-updatable. The obsolete synchronous database methods and API
  adapter surface were removed. Root `pnpm check` passes formatting, production
  builds, lint, generated-contract drift, typechecks, and all 1,158 unit
  assertions. A clean zero-to-`0050` PostgreSQL matrix passes all 305 assertions
  across 24 files, and the six-assertion real API slice proves `202` acceptance,
  exact replay/conflict, safe polling, unchanged pre-projection workspace state,
  invalid restore conflict, and denied direct API mutation. API-key entities and
  external provider subscription revocation still do not exist, and destructive
  purge remains open, so the deletion checklist is not complete.
- API request SLI instrumentation now records count and duration using only the
  Fastify route template, HTTP method, status class, and the finite public
  problem-code vocabulary. Availability outcomes classify successful requests
  and server failures while excluding client-invalid, unauthorized, and
  legitimate tenant-quota responses from the denominator; liveness and readiness
  probes are excluded. Raw URLs, workspace/run IDs, request IDs, and
  arbitrary response codes are never metric attributes. API typechecking and all
  264 API unit assertions pass, including a cardinality regression test.
- A local observability stack now wires OTLP HTTP/gRPC through a memory-limited,
  batched OpenTelemetry Collector into Prometheus and a provisioned read-only
  Grafana operations dashboard. Alert rules cover eligible API error-budget burn,
  outbox and queue oldest age, retention failures, lifecycle-command backlog, and
  dual-ledger disagreement without tenant identifiers. Static asset tests parse
  the dashboard, enforce forbidden high-cardinality dimensions, and prove the
  collector, scrape, datasource, and dashboard provisioning links; all 33
  observability assertions and Compose rendering pass. Local image-level
  `promtool` and Collector validation could not run because Docker credential
  lookup timed out while pulling the pinned images. Production pager routing and
  synthetic fire/clear proof remain organization/deployment work, so the broad
  dashboard/alert checklist remains open.
- Lifecycle-command processing now emits fixed-cardinality command type, outcome,
  and duration metrics, including an explicit failure outcome when no durable
  operation result exists. Restore-before-serve emits agreed/failed control-ledger
  reconciliation count and duration around the complete gate. The alert set now
  uses only emitted series for lifecycle-command failures and dual-ledger
  disagreement. Observability, lifecycle-command, and recovery typechecks pass
  with 47 focused assertions across their suites; high-cardinality operation,
  workspace, sequence, hash, and actor values remain logs/audit data rather than
  metric attributes. Database/Redis/resource and broader worker metrics remain
  open, so the complete telemetry checklist is not marked done.
- Retention worker telemetry now measures each operation independently instead
  of cumulatively from the beginning of a poll, attributes exceptions to the
  exact finite operation stage, and emits dedicated workspace-purge and operator
  maintenance-rerun count/duration series. Rerun outcomes are normalized to a
  finite vocabulary and workspace, command, target, batch, and job identifiers
  remain excluded. The operations dashboard expands from three to fifteen
  panels covering emitted API impact, durable backlog, worker transport,
  trigger/webhook, provider, artifact inventory, retention/purge, operator
  rerun, lifecycle-command, and control-ledger signals. Seventeen Prometheus rules
  are grouped by user impact, durable backlog, resource safety, and destructive
  maintenance; every rule has a description and repository runbook URL. Static
  tests require unique described panels, non-empty PromQL, complete alert
  annotations/runbook sections, a fixed emitted-series inventory, forbidden
  high-cardinality dimensions, and explicit absence of invented PostgreSQL,
  Redis, object-store, or worker-resource series. Retention typechecking and all
  nine retention assertions pass; observability typechecking and all 34
  observability assertions pass; Compose rendering passes. Prometheus `v3.6.0`
  (`sha256:76947e7ef22f8a698fc638f706685909be425dbe09bd7a2cd7aca849f79b5f64`)
  `promtool` validation passes all 17 rules and the complete Prometheus
  configuration. PostgreSQL, Redis, object-store service, and worker
  CPU/RSS/heap/event-loop metrics remain genuine coverage gaps, and the broad
  telemetry/dashboard checklist stays unchecked.
- Schedule-to-start is now measured separately from scanner lag at the first
  successful durable `run.started` commit. The coordinator reads the exact
  canonical `scheduledAt` stored atomically in the schema-validated tagged
  schedule run input and compares it with a fresh PostgreSQL timestamp only after
  the transition transaction, receipt write, and WAL commit return. Only the CAS
  winner emits, so exact replay cannot double-count; as with other in-process
  OpenTelemetry signals, a process crash after commit but before export can lose
  a measurement. Nonnegative durations populate the
  `pertexo.schedule.to_start.duration` histogram; negative durations are excluded
  from latency and counted as bounded `clock_skew` outcomes. Diagnostics cannot
  alter durable workflow truth. The trigger dashboard now compares scan lag and
  schedule-to-start p95, while separate alerts enforce the five-second target and
  page on clock skew. All 202 worker and 34 observability unit assertions pass;
  all 41 coordinator PostgreSQL assertions prove database-observed measurement
  of at least `4.25s` and replay suppression; `promtool` validates all 17 alerts.
  Root `pnpm check` passes all 1,195 unit assertions.
- Repository-owned dependency and process telemetry now closes the remaining
  locally implementable required-metric gaps. A centralized PostgreSQL pool
  factory replaces every production package/worker pool except migrations,
  aggregates connection count/saturation/waiters by finite database credential
  role, absorbs idle-client pool errors, records bounded query and
  transaction duration/outcome, and shares one uninstrumented `pg_stat_activity`
  sampler per connection authority for repository-owned lock waits. Its active
  gauge and completed duration are sampled lower bounds and never expose SQL,
  connection strings, or backend IDs. Redis producer, consumer, notification
  publisher, and API subscriber paths emit bounded operation duration/count and
  lifecycle events; BullMQ-owned command traffic, including duplicated blocking
  clients, is timed under one finite command class, and API readiness performs a
  bounded instrumented `PING`.
  Artifact and control-ledger S3 calls, including presigning, emit request
  duration/count by finite surface, region role, operation, outcome, and error
  class, while existing integrity, readiness, and region-isolation failures emit
  fail-closed safety violations. Worker readiness also checks an enabled artifact
  store and refreshes a dependency-aware ECS health marker every ten seconds.
  Workspace-scoped event payload and checkpoint-state count/byte distributions
  complete the execution-storage growth surface without workspace labels. The
  dispatcher samples this surface asynchronously at most once per workspace per
  five minutes through a bounded, serial queue, so aggregates cannot delay durable
  publication acknowledgements or create unbounded sampler state.
  OpenTelemetry explicitly enables only process CPU/RSS host groups and
  retains runtime-node heap/event-loop metrics without duplicate polling. Every
  worker also samples RSS and event-loop p99 against explicit ECS thresholds;
  three consecutive unhealthy samples mark readiness draining before `SIGTERM`
  activates the existing bounded queue/application shutdown hooks. Every
  production process workload now requires a non-secret
  `OTEL_EXPORTER_OTLP_ENDPOINT` configuration parameter both in its ECS manifest
  and fail-closed runtime parser. The Collector removes
  process/host instance identity and command/executable resource attributes before
  label promotion, preventing restart churn and command-line secret exposure.
  Telemetry observer failures remain isolated from durable behavior. The Grafana
  dashboard expands from 15 to 20 panels and the validated Prometheus rules from
  17 to 22, with exact emitted-series inventory and forbidden-cardinality tests;
  Redis and event-loop rules require backlog or API-impact corroboration.
  Focused suites pass 130 database unit assertions plus two real PostgreSQL
  lock-contention/abandoned-transaction proofs, 129 artifact-store, 39 queue, 266
  API, 204 worker, and 35 observability assertions; `promtool` validates all 22 rules and
  Compose rendering passes. A live local SDK -> OTLP HTTP -> Collector ->
  Prometheus smoke proves the exact database, Redis, object-store, process CPU/RSS,
  event-loop, and V8 heap series used by the dashboard, including the actual
  `process_cpu_utilization` and `process_memory_usage` names and absence of
  process/command identity labels. The complete repository-owned metrics checklist
  is closed. Root `pnpm check` passes all 1,210 unit assertions. Deployed AWS OTLP
  ingestion, managed-service/cloud capacity signals, pager
  routing/fire-clear evidence, and AWS dashboards remain open, so the broader
  dashboard/alert checklist and Phase 7 remain in progress.
- The final locally reproducible release matrix now passes from fresh Docker
  volumes. Zero-to-`0066` migration and embedded exact prior-head fixtures pass
  all 326 PostgreSQL assertions; real S3-compatible artifact I/O passes four
  assertions while the three explicitly skipped MinIO control-ledger assertions
  remain incapable of proving AWS policy semantics. The worker matrix passes all
  24 assertions, including real preview deletion through the maintenance
  credential/coordinator, provider socket-drop redelivery, duplicate fencing,
  webhook/schedule reconciliation, schedule contention/saturation/recovery, and
  drain behavior. The local API matrix passes eight assertions for SSE, direct
  webhook ingress, and real session/workspace behavior. Five process-crash/restart
  assertions, one SSE Redis-loss reconstruction, one sequential Redis/queue/
  PostgreSQL loss plus worker-drain assertion, and one additive compatibility
  rollout assertion pass. The matrix exposed and corrected stale fixtures that
  expected the removed pre-`0053` preview cleanup outbox, activated registry
  releases newer than an email-cohort artifact, counted prior test ledger rows,
  and referenced a nonexistent retained artifact. The current CI configuration
  sets the direct-webhook flag but omits `DATABASE_ADMIN_URL`, so that HTTP
  assertion is silently skipped remotely; whole-repository audit F-04 restores
  this as open work and requires requested gates to fail on missing
  configuration. Root `pnpm check` again passes all 1,195 unit assertions, and
  the production image build, UID 10001/read-only-root smoke, dependency audit,
  fixable-high/critical Grype scan, deterministic deployment render, Prometheus
  validation, and exercise-contract validation pass. This completes the local
  release-matrix criterion only; deployed PostgreSQL failover, object-storage
  outage, real provider outage, pager behavior, AWS rollout, and measured load
  evidence remain open.
- Independent fixed-head Spec and Standards reviews over `25beca0...b87d122`
  report no remaining blocker, high, or medium findings. Review remediation adds
  ADR 030 before owning autoscaling inputs, normalizes active-handler utilization
  by running-task capacity, limits oldest-job age to waiting work, distinguishes
  scan lag from schedule-to-start latency, restricts write latency to
  successful responses, and classifies availability using documented success,
  business-conflict, exclusion, correctness-failure, and capacity-shedding
  outcomes. Nightly and manual/weekly release paths now invoke the complete local
  real-service/recovery workflow. The review checkpoint is complete; the AWS and
  measured-exercise checkpoints above remain open.
- The ADR 015 PostgreSQL recovery-point fence is now executable through
  migration `0069_regional_write_admission.sql`. Production migration startup
  requires explicit enforcement; the restricted maintenance process samples the
  configured Ireland replica every five seconds through `pg_monitor`, records
  only through a security-definer function, and treats missing, non-streaming,
  null, or 15-second-stale evidence as unavailable. The shared transactional run
  acceptance seam pauses every new manual, webhook, schedule, and replay start
  at 300,000 milliseconds while resolving exact idempotent replay before the
  fence. Serving roles have no table access. API and webhook paths return bounded
  `503` retry responses; fixed-cardinality lag/admission metrics, transition
  logs, and `PertexoRegionalWriteAdmissionPaused` provide operational evidence.
  Database unit tests, 48 focused PostgreSQL assertions, 27 focused API
  assertions, all ten retention assertions, contract drift, and deterministic
  deployment checks pass; root `pnpm check` passes all 1,232 unit assertions.
  The shared development database retains a newer test
  compatibility release from earlier work, so the ordinary all-file database
  integration run is not claimed as a clean-volume result; the new disposable
  fence database and exact migration fixtures pass. The live AWS replica and
  pager exercise remains open and Phase 7 is still in progress.
- Startup compatibility and recurring readiness now have explicit, differently
  sized contracts. `WorkspaceDatabase.checkCompatibility` retains the complete
  catalog, role, RLS, grant, function, index, migration, and release validation;
  API startup runs it before listening and worker startup runs it before
  consumption. `WorkspaceDatabase.checkReadiness` performs only bounded
  connectivity, PostgreSQL-version, migration-head, and active-release checks,
  while the existing process probes continue to check live Redis, queue,
  trigger, artifact, and drain state. Unit tests assert that the recurring SQL
  contains no catalog/privilege scan. A disposable PostgreSQL test deliberately
  drifts a security-definer function and proves the startup audit rejects it
  while recurring readiness stays bounded. Database, API, and worker focused
  suites pass, including three disposable PostgreSQL assertions; root
  `pnpm check` passes all 1,233 unit assertions.
- Retention orchestration now delegates seven explicit maintenance classes to
  independently supervised loops rather than one serial failure domain. Each
  loop keeps its own consecutive-failure count, retries with exponential delay
  capped at 30 seconds, emits cardinality-safe failure metrics and structured
  failure/recovery events, and continues until process drain. Shared ledger and
  artifact readiness gates cache only successful checks and are consumed only by
  enforcement, preview, run-artifact, and workspace-purge loops; an object-store
  outage no longer prevents database-only scheduling, dry-run inventory, or
  operator rerun work. Coordinator-internal ordering, durable leases, fences,
  object-before-metadata deletion, and ledger checks are unchanged. Focused
  regressions prove purge failure retries twice and reports recovery without
  starving other work, dependency readiness failure remains isolated, and replica
  observation failure remains independent. All 11 retention assertions pass;
  root `pnpm check` passes all 1,234 unit assertions.
- Identity/workspace persistence no longer owns a divergent transaction helper.
  Workspace access, creation, and lifecycle operations use the shared
  `withTenantScopedClient` path with read-back-verified workspace and actor
  context. Atomic issuer/subject identity resolution uses an explicit
  platform-global entry point, and both public paths share one fail-closed
  transaction engine for abort cancellation, rollback error preservation,
  context cleanup, and poisoned-client destruction. The two focused real-
  PostgreSQL suites pass all 26 identity and transaction-hygiene assertions;
  the hygiene suite uses a disposable database and proves context-free global
  work plus commit-path contamination disposal.
- A-05 coordinator-store decomposition has begun at its transaction seam. The
  read-only repeatable-read and authoritative write wrappers now live in a
  coordinator-private transaction module and share acquisition, abort,
  workspace-context, commit/rollback, and release mechanics without changing
  the public `CoordinatorRunStore` port or SQL transaction boundaries. The
  stable contract and boundary parsers are isolated from implementation, and
  one complete durable operation module now owns delivery validation, receipt
  claim/completion, capacity deferral, mismatch auditing, and acknowledgement.
  Commit-time delivery handling reuses the same module. The focused
  41-assertion real-PostgreSQL characterization suite passes.
- The A-05 authoritative-load operation now lives in a cohesive observation
  module. It retains bounded event paging, canonical fact validation,
  checkpoint/physical-row reconciliation, pending executor failures, artifact
  availability, cancellation/deadline truth, and due wakeups in the original
  repeatable-read transaction. The root coordinator store is reduced from
  approximately 3,200 to 1,892 lines across the completed extractions, and the
  same 41 real-PostgreSQL characterization assertions remain green.
- The authoritative coordinator write transaction is isolated behind
  `commitCoordinatorAdvancePlan`; `coordinator-run-store.ts` is now only the
  stable public composition root for load, commit, acknowledgement, and pool
  closure. The transaction ordering and SQL behavior remain unchanged, and all
  41 real-PostgreSQL coordinator assertions pass. Plan parsing and transition
  validation, loop-barrier/due-ready settlement, and terminal failure-
  notification persistence now have cohesive private modules. The commit
  orchestrator remains the single atomic write authority. Its locked-state
  validation, execution materialization, and run/checkpoint finalization are
  now deep internal modules; `commitCoordinatorAdvancePlan` is reduced from
  approximately 740 lines to 156 without exposing those internal seams. The
  former 3,200-line file remains a 46-line composition root, completing A-05;
  all 41 real-PostgreSQL coordinator assertions pass.
- A-06 engine decomposition has begun with the persisted-observation seam.
  `parsePersistedObservations` now hides bounded normalization, exact shapes,
  canonical timestamps, ordering/deduplication, stale-checkpoint matching,
  cursor advancement, due/deadline facts, and attempt-failure validation in one
  internal module. Shared untrusted-JSON guards are isolated separately, while
  `advanceWorkflow` remains the sole orchestration interface and transition
  authority. All 121 workflow-engine assertions pass. Branch, loop,
  retry/wait, ready-admission, and terminal-selection extraction remained for
  the following checkpoints.
- Coordinator-derived control observations are isolated from the main engine
  operation. One internal module now validates completed-output evidence and
  derives branch selections, Parallel/Merge join declarations and branch
  dispositions, bounded For Each declarations, and iteration completion.
  Recursive executable traversal is shared through its own internal module.
  `operations.ts` is reduced from 2,134 to 946 lines without changing the
  `advanceWorkflow` interface or transition authority; all 121 engine
  assertions remain green.
- Bounded ready admission and terminal run selection are now pure internal
  decision functions. Parallel-scope concurrency accounting and the global
  admission cap are hidden behind one ready-selection interface; terminal
  precedence for unknown outcome, cancellation, deadline, failure, and success
  is hidden behind another. `advanceWorkflowFromSchedulerState` still applies
  both decisions and remains the canonical transition authority. All 121
  engine assertions pass. Persisted retry/wait, due, deadline, cursor, and
  attempt-failure facts remain together in the observation module, while
  checkpoint parsing remains the one reconstruction interface. These modules
  cover every A-06 seam without moving state authority into executors or
  persistence adapters. Scheduler advancement now delegates deterministic
  observation, derived-readiness/join/loop, control-stop, and final-plan
  transition families to cohesive internal modules sharing one private state
  vocabulary. `advanceWorkflowFromSchedulerState` is reduced from approximately
  1,040 lines to 106 and remains the sole orchestration interface. All 121
  workflow-engine assertions pass, completing A-06.
- The final A-06 structural checkpoint splits the 1,961-line database schema
  into ten bounded-context schema modules behind the unchanged `databaseSchema`
  aggregate, and splits the 1,356/1,340-line checkpoint and executable grammar
  modules behind unchanged 92/28-line public boundaries. Repository-wide
  measurement reduced the ratchet from 45 to 36 file hotspots and from 42 to
  40 function hotspots. Schema ownership still accounts for 67 migration
  tables, all 1,599 unit tests and `pnpm check` pass, and the coverage report
  retains 116 reviewed and zero unreviewed branches across 30 selected files.
  The local PostgreSQL integration suite was attempted but was unavailable
  because no database service was listening on port 5432.
- A-07 node-attempt decomposition has begun with stable contract and foundation
  seams. Boundary schemas, lease/result vocabulary, public errors, and the
  narrow worker-facing store interface are isolated from implementation.
  Read/write transaction mechanics share a coordinator-private module, while
  outbox validation, inbox receipt claim/completion, and checksum-mismatch audit
  persistence move together. The complete claim lifecycle is now a cohesive
  internal module: it owns delivery/run validation, row locking, duplicate and
  reconciliation decisions, lease fencing, state changes, and the started
  event while the public worker-facing method remains unchanged. No SQL
  transaction scope changed. Input loading is also isolated behind its existing
  method and original repeatable-read transaction; it retains lease/control,
  invocation-scope, upstream-output, join, nested-loop collection, and
  wait-resume validation. Dispatch persistence is also isolated with its
  connection fence, provider binding compare-and-set, lease fence, and durable
  dispatch marker inside the original write transaction. Heartbeat persistence
  is isolated with current-attempt lease fencing, database-clock renewal, and
  atomic cancellation/deadline observation. Completion is isolated without
  splitting its authoritative transaction: output validation, delivery and
  lease fencing, terminal attempt/node state, retry/reconciliation evidence,
  run events, coordinator wake-up intent, and receipt completion stay atomic.
  The public node-attempt store is now a 65-line composition root. All 136
  database unit assertions and the focused 24-assertion real-PostgreSQL
  execution-runtime suite pass, completing the node-attempt half of A-07. The
  preview half has begun: immutable acceptance and reads now own duplicate
  idempotency resolution, actor/draft/retention admission, prior-preview input
  resolution, and status mapping behind the unchanged public export path. All
  136 database unit assertions and 28 focused real-PostgreSQL preview
  acceptance/worker assertions pass. Preview lifecycle vocabulary is now
  isolated from transport plumbing; durable outbox/receipt validation,
  scheduling, completion, and mismatch auditing share one internal delivery
  module. The complete claim transaction owns state validation, attempt
  fencing, reconciliation wake-up intent, and lease reconstruction behind the
  unchanged public function. Preview heartbeat is isolated with database-clock
  renewal, run expiry, worker identity, and attempt-fence validation in the
  original write transaction. Preview dispatch is isolated with connection
  fencing, provider-binding consistency, worker/attempt fencing, and durable
  dispatch marking in its original transaction. Preview completion is isolated
  without splitting its transaction: stored output/error validation, duplicate
  handling, terminal attempt/run state, terminal audit and usage facts, and
  inbox completion stay atomic. Preview reconciliation now owns bounded stored
  output validation, expired-attempt classification, delayed rescheduling,
  safe/stable-key redelivery, unsafe ambiguity, terminal state/facts, and
  receipt completion under the original transaction scopes. The public
  `preview-execution.ts` entry point is a 57-line compatibility export facade.
  All 136 database unit assertions, the focused 24-assertion node-attempt
  real-PostgreSQL suite, and the focused 28-assertion preview real-PostgreSQL
  suites pass. Both persistence lifecycles now satisfy every A-07 seam without
  broadening their worker-facing interfaces, completing A-07.
- A-08 database capability narrowing is complete. The package publishes six
  direct role entry points: `api`, `execution`, `maintenance`, `lifecycle`,
  `recovery`, and `operator`. Every production application imports its assigned
  surface for static and dynamic loading; none imports the broad compatibility
  root. ESLint rejects root and cross-role database imports in production code
  while preserving the existing API/worker dependency-direction checks. Two
  package-contract regressions fix the manifest paths and prove role surfaces
  do not delegate through `index.ts`. All 138 database unit assertions pass.
- A-09 test decomposition is complete. The 4,643-line workflow-engine
  executable suite is replaced by six invariant-owned suites and one typed
  fixture module; all 121 assertions pass. The 6,365-line coordinator
  persistence suite is replaced by nine durable-transaction/invariant suites
  and focused PostgreSQL fixture helpers; all 41 original assertions pass on
  disposable databases. The 4,067-line worker coordinator transport suite is
  replaced by seven scenario-owned suites covering exact redelivery, failure
  notification, linear execution, Parallel/Merge Redis-loss recovery, For Each
  cancellation, retry/Wait outage recovery, and transport identity fencing.
  The former 1,471-line general fixture is divided into a 551-line
  environment/lifecycle facade, 405-line typed workflow seeding module,
  325-line run/outbox module, and 98-line dispatch module. The shared setup is
  now a short lifecycle orchestrator, and scenarios import focused run and
  dispatch support directly. The transport-enabled worker integration command
  retains real PostgreSQL, BullMQ, Redis-loss, and fresh-worker proofs and
  passes 17 assertions with five unrelated environment-gated scenarios skipped;
  all 204 worker unit assertions, worker test typecheck, and the complete
  repository gate with 1,237 unit assertions also pass. A CI-only race in the
  For Each redelivery proof is closed by requiring both durable PostgreSQL
  progress and terminal BullMQ acknowledgement before removing and republishing
  the completed job; the focused real-transport scenario passes.
- A-10 Phase 7 progress granularity is complete. Combined implementation/live
  evidence rows are split for the control ledger, deletion and purge,
  dashboards and paging, deployment boundaries, and autoscaling. Repository
  implementation is checked only where the fixed-head evidence below proves
  it; production AWS, immutable invocation, pager, measured load/failure,
  backup/PITR, and regional restore evidence remains unchecked. Phase 7 remains
  in progress.
- A-11 readiness hash governance is complete. The nine security- and
  compatibility-critical PostgreSQL function hashes are inventoried with their
  signatures, security modes, search paths, and owning migrations.
  `docs/operations/database-function-readiness.md` defines the synchronized
  forward migration/application rollout, required prior-head coverage, failure
  diagnosis, and forward-only repair procedure. Startup compatibility keeps the
  exact hashes; recurring readiness remains bounded and does not perform these
  catalog checks.
- A-12 TypeScript cleanup is complete. The preview attempt store dependency now
  declares its optional asynchronous close capability, and node-attempt runtime
  construction binds it without `as unknown as`. Existing startup-failure and
  idempotent runtime cleanup semantics are unchanged.
- The historical additive compatibility-rollout isolation finding is closed.
  proof now creates, migrates, and drops its own randomly named PostgreSQL
  database instead of advancing the shared compatibility-release pointer. The
  complete epoch/cohort rollout assertion passes with the shared development
  database untouched.
- The historical preview deadline and identity deviations are closed. The
  accepted ADR 016 amendment ratifies V1 preview identity and separates
  execution from retention. Migration
  `0070_preview_execution_deadline.sql` adds a backfilled, immutable,
  maximum-five-minute `execution_deadline_at`.
  Claim/heartbeat/worker/reconciliation deadline decisions use that field;
  status visibility, prior-preview eligibility, cleanup, and preview artifact
  lifetime retain the independent seven-day `expires_at`. Verification passes
  29 focused real-PostgreSQL assertions, 27 focused worker assertions, 14
  focused API assertions, the one-assertion disposable compatibility rollout,
  the transport-enabled worker matrix (17 passed, five intentionally gated),
  and the complete repository gate with 1,237 unit assertions. A post-push CI
  regression exposed that the original `0070` backfill saw no retained rows
  under forced RLS. The corrected published migration temporarily removes and
  atomically restores forced RLS under the verified owner role; the runner
  recognizes only the exact original published checksum because successful
  empty-database application produced the same final schema. The retained-0023
  upgrade and four startup-compatibility drift assertions now pass together
  (34 real-PostgreSQL assertions).
- Audit finding F-01 is closed by commit `57003e9`. ADR 004 now requires an
  independent OIDC initiating-browser binding. The start route sets a 256-bit secret in a
  callback-path `HttpOnly`, deployed-`Secure`, `SameSite=Lax` cookie whose
  expiry is bounded by the transaction; persistence stores only its digest.
  Migration `0071_oidc_browser_binding.sql` safely invalidates populated
  pre-binding transactions and makes the digest mandatory. Callback consume
  locks the transaction, uses a constant-time digest comparison, and commits
  successful binding verification and single-use consumption atomically before
  code exchange. Success and every terminal failure clear the cookie. API unit
  and type gates pass; focused real PostgreSQL tests pass 21 assertions,
  including populated-`0070` upgrade, wrong-binding non-consumption, and
  concurrent replay; the binding-focused real Nest HTTP scenario passes with
  cookie flags, transport, clearing, rejection, replay, and redaction checks.
- Audit finding F-03 is closed by commit `6496897`. Coordinator and node-attempt
  transaction facades now use the shared hardened tenant engine for pre-use
  context absence, context read-back, post-commit cleanup, rollback-error
  preservation, destroy-on-uncertainty, and acquisition/in-flight cancellation.
  A private repeatable-read seam preserves stable worker snapshots without
  expanding the package's public transaction options. Five focused unit
  regressions and 10 focused real PostgreSQL hygiene/coordinator assertions
  pass, along with all 145 database unit assertions, typecheck, build, ESLint,
  and formatting checks.
- The former whole-repository audit and Phase 4 engineering findings journal are
  consolidated into `docs/whole-repository-audit.md` at audited head
  `8debd0090a972921ce523b0f7809558f6ba7c10d`. The new single source records the
  current architecture and package assessment, resolved prior work, complete
  area-by-area target state, ordered remediation and verification criteria, and
  new findings F-01 through F-20. F-01 is now closed; the audit continues to
  identify P1 work for complete rate limits, truthful direct-webhook CI
  execution, protected required checks, and live Phase 7 evidence. No Phase 7
  completion box changes because
  those code, external-governance, and live-production requirements remain open.

## Historical whole-repository audit remediation — 2026-09-01

Status: **Historical remediation record; superseded by the current-head audit
below**

This section preserves the evidence recorded while the original audit findings
were being remediated. It is not the current findings register. The sole current
audit is [`docs/whole-repository-audit.md`](./whole-repository-audit.md).

The refreshed review covers architecture, functions and classes, imports and
exports, readability, repetition and reuse, TypeScript, NestJS, all twelve
packages, PostgreSQL/data lifecycle, security and privacy, testing and test
layout, CI/CodeQL/branch protection, dependencies, images, observability,
performance, deployment, operations, and documentation.

Current audit state:

- [ ] Complete live AWS, Object Lock, load/fairness, pager, failover, PITR,
      regional restore, RPO/RTO, deployed autoscaling, and aggregate PostgreSQL
      connection-capacity evidence.
- [x] Enable public-repository secret scanning, push protection, and Dependabot
      security updates.
- [x] Add bounded retention/reaping for affected idempotency records and
      expired/revoked sessions.
- [x] Make every requested real-service/compatibility/recovery cohort prove a
      reviewed minimum run with no unexpected skips or todos.
- [x] Protect the production-image scan per change or immutable promotion.
- [x] Refactor the measured readiness complexity hotspot without weakening its
      single-snapshot, fail-closed behavior or public interface.
- [x] Refactor the measured publication complexity hotspot without weakening
      transactions, failure behavior, or public interfaces.
- [x] Correct sibling-feature internal imports and API results that erase exact
      response types to `unknown`.
- [x] Make container OS inputs reproducible, complete pnpm dependency update
      automation, and install a measured complexity ratchet.
- [x] Retire the database compatibility root.
- [x] Replace avoidable test sleeps and document retained external-clock proofs.
- [x] Consolidate the justified local implementation clones.
- [x] Isolate Fastify integration casts behind a checked adapter capability.
- [x] Strengthen review ownership and current-status documentation.

Repository-controlled remediation evidence:

- Commits `042dc35`, `9e2b7c2`, `4e556cf`, and `a7cb42d` preserve exact API
  response types, remove Fastify double assertions, make the production image
  reproducible and scanned with an SBOM, add bounded dependency automation and
  a complexity ratchet, and retire the database production root export.
- Commit `787d220` adds migration `0073_transient_data_retention.sql`, a
  maintenance-only operated reaper, 24-hour terminal replay retention, a
  30-day invalid-session metadata grace period, legal-hold protection, indexed
  bounded deletion, and lock-safe PostgreSQL tests. All 320 database integration
  assertions and 151 database unit assertions passed.
- Required CI cohorts now emit machine-readable reports with reviewed minimum
  counts, exact provider-specific pending counts, and zero unexpected skips or
  todos. Validator tests prove an unset required flag fails the gate; the local
  API cohort passed 15/15 and the MinIO artifact cohort passed its five required
  assertions with exactly three reviewed AWS-policy-only scenarios pending.
- Database readiness now retains one public startup probe and one internally
  consistent SQL snapshot, while capability inventories are split into four
  sub-500-line modules and typed descriptors preserve owner-specific failures.
  The former 1,798-line function and its file/function hotspot baselines are
  removed; 154 unit assertions and 51 real drift assertions pass, including
  policy, grant, function, RLS, role, and migration incompatibilities.
- Workflow publication now retains one author-scoped transaction while named
  internal steps own idempotency claim/replay, locked compilation, immutable
  version persistence, integration/trigger projections, and ordered
  pointer/outbox/audit/completion writes. The authoring factory fell from 817
  to 500 lines and the former 331-line publication function was removed from
  the complexity baseline. All 154 database unit assertions, all 320 database
  integration assertions, and the 17 focused publication/atomicity assertions
  pass.
- API node testing now owns its Nest module, persistence port, authorization
  guard, errors, and routes; workflow authoring no longer imports or re-exports
  the sibling feature. Workflow-run and webhook ingress share checkpoint
  creation through the execution capability, and generic command-header parsing
  lives at the HTTP boundary. A static boundary suite rejects all corrected
  sibling crossings. All 332 API unit assertions, API typecheck/build, and the
  relevant ESLint and complexity gates pass.
- Identity integration accepts an injected clock, replacing the 5.1-second
  session-expiry sleep with deterministic advancement; the schedule recovery
  fixture advances its mutable PostgreSQL lease timestamps. Long waits retained
  for immutable entitlement/preview facts, Redis expiry, BullMQ lease/retry,
  and cross-process artifact quiescence are documented as real boundary proofs.
  Six real identity API assertions and 28 focused PostgreSQL assertions pass.
- API and worker observability modules now delegate identical logger adaptation,
  provider registration, and telemetry shutdown to one framework-neutral
  observability capability. Slack and email execution telemetry delegate their
  identical bounded metric/span lifecycle to one typed worker factory while
  retaining provider-specific error classification. All 39 observability, 205
  worker, and 332 API unit assertions pass, including provider failure and
  lifecycle coverage.
- `docs/current-implementation-status.md` now provides a concise phase/blocker
  view linked from README, while this file remains the detailed evidence
  journal. Critical paths have explicit CODEOWNERS. The protected-branch policy
  and documented solo-maintainer exception preserve mergeability until a second
  reviewer exists; at that point one approval and code-owner review become
  mandatory.
- GitHub reports secret scanning, push protection, vulnerability alerts,
  Dependabot security updates, and automated security fixes enabled. Validity
  checks and non-provider patterns remain unavailable on the current plan. Main
  now requires `production-image` in addition to its ten prior strict contexts;
  the job builds the exact commit image, proves non-root/read-only execution,
  emits a CycloneDX SBOM, and fails on fixed high/critical vulnerabilities.

Verification at implementation head `9e4263794715d273e8660c0dd4efa67c5032e940`:

- `pnpm check` passed formatting, build, ESLint, generated contracts,
  TypeScript, and 1,312 unit-level tests;
- `pnpm test:coverage` passed the four critical-module branch thresholds
  (workflow engine 79.36%, database 61.53%, worker 62.79%, API 82.56%);
- `pnpm audit --prod --audit-level high` reported no known vulnerabilities;
- `pnpm deployment:check`, `pnpm images:check`, and
  `pnpm exercise:check` passed; and
- GitHub Actions CI run `33374292338` and Release Gate run `33378998330`
  passed at the implementation head; CodeQL was green.

That historical documentation-only audit did not change a Phase 7 completion
box. Its repository P1 findings are now closed; the live-production checklist
below remains the release blocker.

## Current whole-repository audit — implementation tree `d1b41b6e9b6122de9914298e486c4b4635742f28`

Status: **Repository-controlled audit blockers are complete; external
production/control evidence remains open**

Repository-controlled remediation:

- [x] Stabilize destructive PostgreSQL restart control with exact container
      identity, bounded documented-race retry, health deadline, and negative
      failure fixtures. Three consecutive clean local destructive cohorts pass.
- [x] Bind the production image digest and commit to the hashes of its SBOM and
      scanner report. The manifest explicitly refuses to claim registry
      attestation; publish/sign/promote-by-digest remains external.
- [x] Remove all eight specifically named branch-heavy functions from the
      complexity baseline through private invariant-owned modules. The current
      leading hotspot is 220 lines/44 branches, down from 257/102, with no new
      or worsened ratchet entry.
- [x] Complete the selected-file risk review through public module interfaces.
      Report schema V6 names the 23 exact selected files with portable paths;
      manifest schema V4 groups reviews by file and binds all retained reviews
      to semantic source fingerprints. Private-state tests and 26 unsupported
      generic integration claims were removed. Public replacements currently
      measure 91.02% workflow engine, 95.38% database, 93.14% worker, and 100%
      API branch coverage across 30 selected files and 1,736 coverable lines,
      with 116 reviewed and zero unreviewed sites. The API cohort now executes
      every selected statement, branch, function, and line, including malformed
      request-instance parsing and owned rate-limit shutdown.
- [x] Split production dependency updates into HTTP, validation, AWS,
      telemetry, queue, and routine compatibility groups and document owner,
      triage, isolation, and bounded-deferral SLAs.
- [x] Align `@types/node` 24.13.3 with Node 24 engines, CI, and Docker stages;
      fourteen fixtures also reject dynamic selectors, `node-version-file`, a
      setup-node step without its own literal selector, malformed workflow
      YAML, and case-variant `actions/setup-node` drift. Pinned `yaml` 2.9.0
      parsing recognizes quoted actions, ignores block-scalar text, checks
      selector ownership against the exact parsed step's `with` mapping, and
      compares the GitHub repository identity case-insensitively. Checkout,
      pnpm setup, Node setup, and artifact-upload actions are pinned to
      immutable v6 releases that declare the Node 24 action runtime.
- [x] Consolidate request-header policies in the private HTTP platform and
      artifact metadata equality in the private artifact-store implementation
      without adding public exports. The later coordinator validation
      `assertPlan`/`sameStoredValue` duplicate is likewise centralized in one
      private database module.
- [x] Compare the pre-refactor and candidate database, workflow-engine, and
      workflow-model package seams across five rounds. Median wall-clock deltas
      are +0.36%, +3.13% (with three extra tests), and 0.00%; median maximum-RSS
      deltas are +1.18%, +0.26%, and +0.23%. Query-call inventory falls from 215
      to 213 with no new SQL/round trip. See
      `docs/operations/complexity-refactor-performance.md`.
- [x] Refresh README/current-status/audit/tracker semantics at a fixed
      implementation snapshot while preserving the historical red CI evidence.
- [x] Add a repository command for local Markdown targets and heading anchors,
      synchronize the audited implementation tree across the
      audit/tracker/current-status documents, prove that tree occurs in the
      publication ancestry, and give the solo-maintainer exception an owner and
      bounded review date.
- [x] Run the documentation command from protected quality CI with complete Git
      history and cover candidate recreation on another parent with a fixture.

Fresh audit findings at the implementation tree named above:

- [x] Correct the worker's runtime dependency on `@pertexo/workflow-model`,
      which is currently declared only as a development dependency, and add an
      isolated production-install/image role-load smoke.
- [x] Own and stop/unreference the worker process keepalive; the lifecycle
      and compiled-process regressions prove clean bounded SIGTERM exit with
      consumers disabled or active and during bootstrap failure. The deployed
      ECS drain drill remains live Phase 7 evidence.
- [x] Replace the polynomial-time logger redaction path, add bounded adversarial
      tests, and make high-severity code-scanning results merge-blocking.
      Pull-request and exact-main CodeQL are green, the historical alert is
      closed, and active repository ruleset `22213497` blocks CodeQL errors and
      high/critical alerts on `main`.
- [x] Resolve both the direct Fastify 5.12.0 and Nest-transitive 5.11.3 paths to
      a fixed release, retain the proxy/validation regression behavior, and
      make unaccepted moderate production advisories fail admission.
- [x] Enforce UUIDv7 for application-owned persisted IDs, account for all 67
      migration-owned application tables, and force RLS on the workspace-keyed
      retention scheduler state through forward-only migration `0074`. A final
      UUIDv4 assertion sweep moved persisted browser-session IDs to the central
      UUIDv7 generator and retained independent randomness for bearer tokens.
      Persisted artifacts now use the same generator by default and expose an
      injected identity only as an explicit test seam.
- [x] Retain outbox ownership when either queue publication or its durable
      `markPublished` update exceeds the caller deadline. Both late promises are
      owned to settlement, surface `outcome_unknown`, and cannot trigger lease
      release or retry while authoritative truth can still change.
- [x] Carry out the repository-controlled P2/P3 maintainability,
      selected-coverage, package-surface, test-organization, and public-
      governance improvements in `docs/whole-repository-audit.md` without
      weakening existing invariants. Hosted signed provenance and live provider
      evidence remain the credential-dependent A-08/Phase 7 work below.
- [x] Complete the partially reopened A-11 test-maintainability work: extract
      genuinely shared setup from paired split suites into owner-local support
      modules, keep scenario state/assertions local, document and automate the
      exact full-corpus clone scan from 25 groups/1,977 lines (2.08%) to 6
      groups/267 lines (0.29%) without weakening independent collection or
      integration isolation. The paired worker transport actions remain local
      to their scenario files rather than being hidden in shared setup.
- [x] Implement code-audit C-22 through focused capability-local database
      source moves that preserve package entry points, transaction ordering,
      migration behavior, and real-PostgreSQL evidence; do not perform one
      repository-wide relocation. The root now retains 12 public/composition
      files and ten capability-owned directories.
- [x] Complete code-audit C-28 by pinning reproducible source/test clone scans,
      classifying retained semantic clones, and enforcing a no-new-or-worsened
      baseline in protected CI. C-21 shares the test-side implementation;
      exact semantic identities reject stale or worsened explanations.
- [x] Complete code-audit C-26 source terminology cleanup by moving the
      persisted checkpoint owner and symbols to durable names and using the
      baseline runtime-policy name internally. Retain the deprecated public
      alias, serialized engine identifier, migrations, readiness fields, and
      database objects as explicit compatibility contracts.
- [x] Record the C-25 immutability/optional-property ownership policy. No
      freeze or copy is removed without mutation or performance evidence.
- [x] Re-run the complexity inventory after capability moves: 35 file and 40
      function hotspots remain individually reasoned and non-regressing.
- [x] Run final local admission: `pnpm check`, `pnpm test:coverage`,
      `pnpm release:check`, and `pnpm images:check` pass. Enabled real-service
      cohorts pass 320 database, 22 worker, 15 API, and 5 artifact-store tests;
      provider-specific local skips remain distinct from live Phase 7 evidence.
- [x] Observe protected pull request #40 CI run `33818101198` pass every
      required context, exact-main CodeQL run `33818839834` pass at `4e8585b`,
      and scheduled CI run `33848095363` pass every configured job on the same
      exact commit. Push CI run `33818839787` is retained as failed external
      evidence because only its fail-closed npm advisory lookup timed out.

Code-audit C-23 through C-25 and C-27 are controlled, continuous,
evidence-gated, or conditional work rather than unconditional completion
checkboxes. Their activation and acceptance evidence are recorded in
`docs/code-audit.md`.

Still open:

- [x] Replace historical failed run `33458288161` with fully green protected
      pull request #7 run `33465359665`; recovery job `99723971025` passed.
- [ ] Complete live AWS, Object Lock, pager, load/fairness, failover, failback,
      PITR, regional restore, RPO/RTO, autoscaling, and aggregate PostgreSQL
      connection-capacity evidence.
- [ ] Execute controlled provider-approved push-protection,
      vulnerable-dependency, and vulnerable-image rejection canaries.
- [ ] Select registry/signing identities, publish signed provenance, promote the
      scanned image by digest, and prove the deployment consumes that digest.
- [x] Review and classify consequential uncovered sites from the emitted
      inventory, add corresponding failure-injection/mutation cases, and
      observe the new dependency groups in the next automation cycle. The
      selected-file report now records 116 reviewed and zero unreviewed sites,
      and the split dependency groups have produced their first automation
      branches.
- [ ] Require independent approval/code-owner review and verified provenance
      when a second maintainer and signing identities exist; retain the
      documented solo exception until then.
- [x] Observe the documentation validator pass in pull request #26 CI run
      `33642321558` and exact-main CI run `33643208313` after the supported
      rebase-style merge.

Audit calibration now records its method explicitly. Architecture uses the
repository's deep-module/interface/seam criteria. Security is cross-checked
against NIST SSDF, OWASP SAMM, OpenSSF Scorecard, SLSA, and GitHub artifact
attestation guidance. Testing, delivery, and production readiness are
cross-checked against Google's test-size/flakiness evidence, DORA, and Google's
SRE production-readiness model. The numeric scores are rubric-based engineering
judgments with documented arithmetic, not industry percentiles or claims that a
particular file size, package count, or coverage percentage is universally
correct.

Verification for implementation tree `5c32211ac3e33794826b07a340ad25e8ed91a2ef`
and its audit publication branch:

- `pnpm docs:check` validated 25 repository-local links across 49 Markdown
  files, synchronized the three audit-tree claims, proved the audited tree
  occurs in publication ancestry, and passed a rebase-style recreation fixture;
- `pnpm check` passed formatting, the Node 24 compatibility gate, all builds,
  ESLint, complexity, generated contracts, TypeScript, and 1,529 unit tests
  across all 18 workspace projects;
- `pnpm test:coverage` passed at 90.64% workflow-engine, 94.23% database,
  91.86% worker, and 99.64% API branch coverage and recorded 116 exact
  source-fingerprinted reviews plus zero unreviewed sites;
- the full configured real-service matrix passed 5 artifact-store, 320
  database, 21 worker, and 14 API integration tests; the 3 artifact-store, 1
  worker, and 2 API provider-specific skips remained explicit;
- three destructive transport-recovery runs passed before the final lint-only
  correction, whose controller fixtures and full unit suite also pass;
- `pnpm security:audit` passed at the high threshold after transitive
  `fast-uri` patch overrides; `pnpm deployment:check`, `pnpm exercise:check`,
  and `pnpm images:check` passed;
- a real BuildKit production-image build emitted and bound digest
  `sha256:fda47b1215439a714ac7d0042fe41b4f8adfe62a7bc0c43c711cd029cb436bce`;
  and
- pull request #7 merged to `main` after CI run `33465359665` passed all 11
  protected contexts, including recovery and integration; CodeQL run
  `33465359620` also passed.
- Exact-main CI run `33635957948` and CodeQL run `33635958168` passed the
  configured protected jobs, but the quality job omitted `pnpm docs:check` and
  therefore did not catch the rewritten candidate SHA that made canonical
  `pnpm check` fail on merged `main`; the publication corrects the shared audit
  head. Protected enforcement was still open at that point.
- Pull request #26 CI run `33642321558` passed every protected context. Its
  quality job explicitly executed `pnpm docs:check`, resolved audited tree
  `640cbea`, and passed the rebase-style fixture.
- Rebase-merged `main` recreated candidate implementation commit `78c0e4e` as
  `f3ca694` while preserving tree `640cbea`. Local exact-main documentation
  validation and quality job `100291244127` in CI run `33643208313` passed;
  CodeQL run `33643208280` passed.

No phase status changes. Phase 7 remains **In progress**. Repository work must
not be mistaken for the live deployment evidence required by the plan.

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
