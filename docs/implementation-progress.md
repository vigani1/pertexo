# Backend Implementation Progress

Last updated: 2026-08-25

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
| Phase 3 — first executable-node slice | Complete | ADR 010; implementation through `7487ae6`; migration head `0019_node_compatibility_preactivation.sql`; 575 unit and 217 sequential real-service assertions; five process-recovery, one transport-outage, one SSE-outage, and one additive-rollout assertion; independent Spec and Standards completion GO |
| Phase 4 — first side-effecting integration slice | Complete | ADRs 007/016; implementation through `28ae56b`; migration head `0031_due_node_wakeups.sql`; 248-database-assertion clean CI matrix plus real PostgreSQL/outbox/BullMQ retry-wakeup proof; CI recovery/service-loss matrix; independent fixed-head Spec and Standards completion GO |
| Phase 5 — orchestration slice | Complete | ADRs 008/017/018/019/020/021/022; implementation through `9d7e071`; migration head `0034_run_failure_notifications.sql`; 862 unit assertions and complete real-service/recovery matrix; independent fixed-head Spec and Standards completion GO |
| Phase 6 — V1 providers and triggers | In progress | ADRs 012–014 and 023–026; Slack `slack.send_message@1`, email `email.send_notification@1`, failure-notification destinations, and shared execution admission/fair dispatch are active at migration head `0038`; Webhook and Schedule remain |
| Phase 7 — production operations | Not started | — |

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

Status: **In progress**

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
- [ ] Complete webhook
      reconciliation, raw-byte verification, deduplication, and run acceptance.
- [x] Accept ADR 014 before implementing Schedule.
- [ ] Complete Schedule and prove timezone, DST,
      misfire, PostgreSQL authority, and recovery behavior.
- [ ] Keep polling deferred unless launch validation explicitly promotes it.

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
- [ ] Add one workflow policy reference outside graph topology and atomically pin
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

- [ ] Complete Slack, email, failure-notification destinations, Webhook, and
      Schedule in that order; do not add polling.
- [ ] Run root checks, provider contracts, zero/prior-head migrations, complete
      real-service matrices, retained recovery fixtures, and additive rollout.
- [ ] Record exact versions, commands, assertion counts, timings, cleanup, and
      post-test dependency health.
- [ ] Resolve every blocker/high finding from independent fixed-head Spec and
      Standards reviews and push all coherent implementation/evidence commits.

Current evidence:

- ADRs 012–014 and 026 are accepted before trigger implementation. PostgreSQL
  owns entitlement admission and fair rounds, retention/deletion/hold progress,
  schedule occurrences, and webhook replay truth. Generic webhook ingress uses
  exact-raw-byte HMAC with a five-minute window and 256-KiB JSON limit; Schedule
  pins five-field local cron/interval, IANA timezone, deterministic DST and
  misfire behavior, and requires implementation to pin `cron-parser` 5.10.0
  directly before Schedule is exposed.
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
  the same outbox identity for deterministic republish instead of stranding the
  run or its allowance. Saturated workspace windows still advance the durable
  cursor, and a fresh dispatcher instance continues after it, while queue
  contracts and identifier-only BullMQ jobs remain unchanged; preview admission
  and cleanup code are untouched.
- Focused verification on 2026-08-25: a fresh PostgreSQL 18 database applied all
  39 reviewed revisions from zero through `0038`; the exact prior-head path is
  covered by the disposable coordinator matrix. Database unit tests pass 69
  assertions. Disposable PostgreSQL suites pass 34 acceptance assertions
  (including 101 concurrent requests with exactly 100 accepted), 40 coordinator
  assertions, and 19 outbox/dispatcher assertions. The focused API problem and
  persistence suites pass 14 assertions, and root `pnpm check` passes formatting,
  builds, lint, contract drift, typechecks, and 954 unit assertions. Complete
  Phase 6 trigger real-service/process recovery gates remain open; Phase 6 stays
  in progress because Webhook and Schedule are unfinished.
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

## Later Phases

Use the delivery plan and vertical-slice completion rule as the checklist for
Phases 6–7. Expand the relevant phase here before implementation begins; do not
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
