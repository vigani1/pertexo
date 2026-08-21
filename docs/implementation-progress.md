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
| Phase 0E — execution durability proofs and engine gate | Complete | ADRs 005 and 007–009; commits through `0322837`; 239 unit, 96 real-service integration, five process-recovery, one SSE-outage, and one transport-outage assertions; custom-engine GO |
| Phase 1 — identity/workspace vertical slice | Complete | ADR 004; migration head `0011_workspace_creation_idempotency.sql`; 347 unit and 133 real-service assertions; generated contract drift gate; independent Spec and Standards completion GO |
| Phase 2 — workflow authoring vertical slice | Complete | ADRs 002/011; migration head `0012_workflow_authoring.sql`; 414 unit and 150 real-service assertions; generated contract drift gate; independent Spec and Standards completion GO |
| Phase 3 — first executable-node slice | In progress | ADR 010; executable registry/runtime and public run slice through `a7eaf42`; durable compatibility authority, retained fixtures, lifecycle/non-removal, and recovery matrix through `66dafb7`; migration head `0018_phase3_core_executor_non_removal.sql`; rolling preactivation and final evidence remain |
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

Status: **In progress — executable packages, persistence, consumers, public run API, PostgreSQL-authoritative SSE, active-cancellation recovery, and the initial durable compatibility release are complete; rolling preactivation and final evidence remain**

Phase 3 has completed its design prerequisites, package foundations, durable
coordinator/attempt state, and readiness-gated execution consumers. The exact
Manual -> Set/Map -> Terminate graph now executes through PostgreSQL, Redis, and
BullMQ with duplicate attempt delivery. Authorized publication now compiles and
stores its exact V2 executable envelope, and the public Start/Get/Stream/Cancel
slice is live. The initial durable compatibility-release authority, exact
retained fixtures, active-work cancellation recovery, and the Phase 3
non-removal barrier are now complete. Rolling target preactivation/deployment
approval and the final Phase 0/fleet evidence gates remain.

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
- [ ] Prove additive-before-subtractive rolling releases: the complete worker
      cohort supports and reports an exact compatibility epoch/fingerprint
      before API publication or placement can create a reference, and mixed API
      replicas fail closed through the documented conservative ETag conflict.
- [ ] Persist append-only audited compatibility-release records plus the
      current epoch/fingerprint in PostgreSQL. Require role-specific expected-
      pair validation, target-pair preactivation readiness, deployment approval,
      and same-transaction current-release locking for publication and new
      admission; deployment evidence supports but never replaces the durable
      authority.
- [ ] Make readiness fail closed on duplicate identities, invalid bindings,
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
- [ ] Prove authorization, capability checks, hidden cross-workspace resources,
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
- [ ] Pass real PostgreSQL + Redis + BullMQ tests for the full thin graph,
      duplicate deliveries, enqueue-before-mark recovery, consumer readiness,
      drain behavior, and process restart boundaries.
- [ ] Re-run every applicable Phase 0B tenancy failure: absent workspace
      context, cross-workspace reads/writes, commit/rollback and sequential/
      concurrent pool reuse, non-owner/non-`BYPASSRLS` runtime roles, forbidden
      grants, forced-RLS/policy drift, and incompatible migration readiness.
- [ ] Re-run every applicable Phase 0C HTTP/observability failure: invalid or
      propagated request identity, safe RFC 9457 mapping, recursive secret/error
      redaction, trace/metric bootstrap and correlation, dependency readiness,
      bootstrap cleanup, graceful `SIGTERM` drain, and package/server-only export
      boundaries.
- [ ] Re-run every applicable Phase 0D queue/outbox failure: transactional
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
- [ ] Re-run the Phase 0E Redis-loss SSE reconstruction and worker transport
      outage/drain fixtures, proving PostgreSQL remains authoritative and no
      work is claimed after readiness falls.
- [ ] Run the root `pnpm check` and the complete real-service integration
      matrix sequentially in dependency-safe order, then record commands,
      versions, assertion counts, timings, migration head, and cleanup/health
      evidence here.
- [ ] Complete independent Spec and Standards reviews against the fixed Phase 3
      HEAD with no blocker/high findings, including package direction,
      generated artifacts, manifest/lockfile coherence, unsafe casts, node
      compatibility, and tracker accuracy.
- [ ] Mark Phase 3 complete only after every box above is checked and concrete
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

## Later phases

Use the delivery plan and vertical-slice completion rule as the checklist for
Phases 3–7. Expand the relevant phase here before implementation begins; do not
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
