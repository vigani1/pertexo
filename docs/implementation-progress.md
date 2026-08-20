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
| Phase 2 — workflow authoring vertical slice | In progress | ADRs, canonical graph identity, and tenant-scoped persistence complete; dispatch and HTTP slice remain |
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

Status: **In progress**

The phase has started at its required ADR/design prerequisite. No implementation
item below is complete yet. Phase 2 remains incomplete until the whole thin
slice satisfies the plan's vertical-slice completion rule with executable
evidence.

Plan-aligned checklist:

- [x] Accept ADR 002 for PostgreSQL JSONB drafts, immutable versions,
      versioned executable-projection checksum identity, and identical-content
      version reuse before workflow persistence is implemented.
- [x] Accept ADR 011 for whole-graph optimistic draft concurrency,
      strong ETag semantics, HTTP preconditions, conflict responses, and the
      future collaboration boundary before the draft save API is implemented.
- [ ] Define the workflow-authoring domain vocabulary and canonical constants,
      including lifecycle/activation states, draft revision rules, graph schema
      versioning, and immutable version identity.
- [ ] Own the canonical graph, authoring request/response, validation-report,
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
- [ ] List workspace workflows with deterministic cursor pagination and load
      one authorized draft with its revision, strong ETag, and
      definition-compatibility report without exposing cross-workspace
      existence. The strong validator covers the complete returned
      representation, including the compatibility fingerprint; a registry
      rollout may therefore require a safe refetch instead of treating two
      different reports as equivalent.
- [ ] Save one coherent, structurally valid, within-limit graph snapshot only
      when a required strong `If-Match` value matches; return HTTP `428` when
      the precondition is absent and HTTP `412` with
      `workflow.revision_conflict` when it is stale or does not match. Increment
      the revision on success and never overwrite concurrent work.
- [ ] Validate the current draft read-only using the same graph limits and
      pinned-definition compatibility rules used by publication, returning a
      stable typed validation report without mutating the draft.
- [x] Define a versioned canonical executable projection for checksum identity.
      It includes execution-relevant graph/schema/definition/settings content
      but excludes presentation-only metadata such as node position and label;
      focused fixtures must prove both included and excluded fields.
- [ ] Publish in one transaction: require the same strong `If-Match` contract
      plus an `Idempotency-Key`, lock and freeze that coherent draft revision,
      run deterministic validation, calculate the versioned
      executable-projection checksum, create or reuse one immutable version,
      update the same workflow's published pointer while keeping activation
      inactive, append the audit fact, and write one versioned
      `workflow.published` outbox record at the existing typed
      `reconcile-workflow-triggers` dispatch boundary.
- [ ] Give publish commands durable idempotency semantics: an exact retry with
      the same key, original `If-Match`, and request hash returns the stored
      result before current-state comparison and without another audit fact or
      outbox record; reusing the key for a changed request returns
      `request.idempotency_conflict`; a distinct key with a stale validator
      returns `workflow.revision_conflict` `412`, while a distinct key with the
      same current executable content is a new publish attempt that reuses the
      existing version and records its own audit/outbox effects.
- [ ] Add a validated dispatcher job-kind allowlist. Phase 2 excludes
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
- [ ] Expose and document only the Phase 2 endpoints: list/create workflows,
      get/save draft, validate, publish, and list immutable versions. Controllers
      remain limited to contract parsing, authenticated actor/workspace context,
      one use-case call, and response mapping.
- [ ] Enforce named workflow read/update/publish capabilities plus active
      workspace membership at the application boundary and PostgreSQL tenant
      isolation through the real Phase 0/1 runtime roles.
- [ ] Map malformed input, hidden resources, authorization failures, revision
      conflicts (`428`/`412`), invalid workflows, idempotency conflicts, and
      unexpected failures through the shared RFC 9457 catalog with bounded safe
      logs.
- [ ] Add fixed-cardinality traces/metrics and the relevant audit/outbox effects
      without workflow, workspace, actor, or version IDs in metric labels.
- [ ] Publish browser-safe shared client contracts and deterministic generated
      API/client artifacts, and make contract drift a required verification
      gate before the canvas consumes the API.
- [ ] Prove the use-case transaction boundaries, rollback behavior, exact and
      conflicting retries, strong-ETag preconditions, concurrent draft saves,
      save-versus-publish races, concurrent/duplicate publishes, exactly one
      live draft, immutable frozen history, executable-projection checksum
      inclusion/exclusion, authorization, cross-workspace isolation, RLS/grants,
      and safe problem responses with unit plus real PostgreSQL/HTTP integration
      tests.
- [ ] Run the repository-wide quality gate and the full applicable real-service
      integration suite, record exact assertion counts and migration head, and
      resolve every blocker/high finding from independent Spec and Standards
      completion reviews.
- [ ] Connect the canvas only after every API, authorization, conflict, publish,
      contract, and verification item above passes; canvas work does not count
      toward backend Phase 2 completion.

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
- Independent Spec and Standards reviews returned GO for the model and
  persistence checkpoint. The worker role cannot read workflow versions, every
  workflow stays inactive, and reconciliation outbox rows remain held pending
  the separate dispatch-capability checkpoint and the Phase 6 consumer.

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
