# Whole-Repository Architecture and Code Audit

Recorded: 2026-08-28

## Purpose and scope

This document records the findings from a read-only audit of the backend at
commit `2c8b41f`. The authoritative baseline was:

- `docs/workflow-platform-backend-plan.md`;
- ADRs 001–030;
- `docs/implementation-progress.md`;
- the production and recovery runbooks;
- the current migrations, source code, tests, deployment manifests, and CI
  workflows.

The audit covered architecture and dependency direction, durable state and
distributed-system correctness, persistence and RLS, security boundaries,
observability, tests, operational readiness, TypeScript design, and actual code
quality. Repository-wide inventory and static scans were combined with close
reading of the architecture-critical engine, execution, persistence, identity,
integration, lifecycle, recovery, operator, and API paths. It was not a manual
line-by-line review of every one of the repository's approximately 183,000
TypeScript and SQL lines.

No implementation files were changed as part of the audit. At the audited head,
`pnpm typecheck` passed across all workspace projects and `pnpm test` passed all
1,226 unit-level tests. Environment-dependent integration, live load, failover,
and regional recovery exercises were inspected but not rerun for this audit.

## Overall assessment

The backend is architecturally sound and unusually rigorous about PostgreSQL
authority, tenant isolation, immutable compatibility, duplicate delivery,
idempotency, dispatch uncertainty, and recovery. The engine remains independent
of NestJS, PostgreSQL, Redis, BullMQ, and HTTP. Redis and BullMQ remain transport
and coordination mechanisms rather than competing durable authorities.

The implementation is not yet as maintainable or operationally proven as the
architecture deserves. The highest-value work is to make readiness inexpensive,
isolate maintenance failures, complete real environment exercises, consolidate
tenant transaction hygiene, and reduce the responsibility size of several core
modules without weakening their correctness guarantees.

| Area | Score |
| --- | ---: |
| Architecture | 9/10 |
| Architecture adherence | 9/10 |
| System design | 8/10 |
| Implementation quality | 8/10 |
| TypeScript quality | 9/10 |
| Maintainability | 7/10 |
| Test quality | 9/10 |
| Security | 9/10 |
| Observability | 8/10 |
| Performance and scalability readiness | 7/10 |
| Production readiness | 6/10 |
| Simplicity | 6/10 |

## Release-blocking work

No confirmed source defect was found that currently demonstrates tenant escape,
authorization bypass, duplicate unsafe dispatch, corrupt state transition, or a
Redis-as-authority violation. Production release should nevertheless remain
blocked until the following operational work is complete.

### A-01: Separate startup compatibility validation from steady readiness

- **Severity:** High
- **Category:** operational reliability and performance
- **Files:** `apps/api/src/platform/health/ready.controller.ts`,
  `packages/database/src/database.ts`, `packages/database/src/readiness.ts`
- **Symbols:** `ReadyController.ready`, `WorkspaceDatabase.checkReadiness`,
  `checkDatabaseReadiness`
- **Classification:** should be corrected

Every API readiness request invokes the complete database compatibility audit.
That audit checks catalog ownership, roles, ACLs, policies, indexes, triggers,
function attributes and source hashes, migration state, and compatibility
releases. The check is valuable at startup and release time, but it is too large
and brittle to be the recurring steady-state health query.

Repeated orchestrator probes can create catalog load, amplify transient database
latency, and cause synchronized readiness flapping. Split the behavior into:

1. a fail-closed startup/release compatibility check that retains the complete
   schema and privilege audit; and
2. a lightweight recurring check for connectivity, migration head, active
   compatibility epoch, and serving dependencies.

Immutable compatibility results may be cached after startup. Live authority
that can legitimately change while the process is running must still be checked.
This should preserve behavior, but the change has medium risk because excessive
caching could hide an incompatible rollout.

### A-02: Isolate unrelated retention and maintenance failures

- **Severity:** High
- **Category:** failure isolation and lifecycle
- **File:** `apps/retention/src/run.ts`
- **Symbol:** `runRetentionWorker`
- **Classification:** should be corrected

Operator reruns, enforcement scheduling, dry runs, standard retention, preview
cleanup, run-artifact deletion, and workspace purge execute serially inside one
loop. An exception from any operation terminates the loop and shuts down every
coordinator. An object-store problem in artifact cleanup can therefore stop
unrelated database-only maintenance until the process is restarted.

Add bounded per-operation retry and backoff and maintain independent failure
state for unrelated maintenance classes. Preserve ordering within one destructive
workflow. Separate supervised loops or deployment roles are reasonable only
where they improve genuine failure isolation; do not create a generic job
framework. Add regression coverage proving one failing class does not starve
unrelated eligible work and that persistent failure remains observable.

### A-03: Complete live production exercises and retain measured evidence

- **Severity:** High
- **Category:** production readiness and testing
- **Files:** `docs/implementation-progress.md`,
  `.github/workflows/release-gate.yml`, `infrastructure/exercises/**`,
  `docs/operations/regional-recovery.md`
- **Classification:** should be corrected

The repository contains strong deployment, exercise, recovery, ledger, artifact,
dashboard, and alert machinery. The current automated gates primarily validate
their contracts and local behavior. They do not prove real PostgreSQL failover,
regional restore, sustained saturation, or measured RPO and RTO.

Before launch, execute the documented profiles and failure exercises against an
environment representative of production. Retain results for:

- webhook bursts and sustained workflow admission;
- large fan-out and long waits;
- noisy-tenant fairness under saturation;
- Redis loss, provider outage, worker drain, and object-store degradation;
- PostgreSQL failover and restore;
- control-ledger reconciliation before traffic;
- artifact replica inventory and repair behavior; and
- measured five-minute RPO and 24-hour regional RTO.

The release decision should reference exact reports, environment versions,
timings, failure observations, and cleanup evidence.

## Maintainability and code-quality work

### A-04: Consolidate identity tenant transaction hygiene

- **Severity:** Medium
- **Category:** persistence, tenancy, and historical drift
- **Files:** `packages/database/src/identity-workspace.ts`,
  `packages/database/src/workspace.ts`
- **Symbols:** `withTransaction`, `withTenantScopedClient`
- **Classification:** harmless drift today; should be corrected

Most tenant-scoped persistence now uses the hardened `withTenantScopedClient`
primitive. Identity/workspace persistence retains a separate implementation.
The latter checks for retained context before and after a transaction but does
not verify context read-back, has no abort-driven wire cancellation, suppresses
rollback errors, and duplicates pooled-client cleanup rules.

Route tenant-scoped identity operations through the hardened primitive. Keep a
separate platform-global transaction path only for operations that genuinely
have no workspace scope. Preserve atomic user, identity, membership, workspace,
and idempotency semantics. Add focused real-PostgreSQL tests before deleting the
old helper.

### A-05: Split the coordinator run store by durable operation

- **Severity:** Medium
- **Category:** readability, cohesion, and change risk
- **File:** `packages/database/src/coordinator-run-store.ts`
- **Classification:** partially reducible complexity

At approximately 3,200 lines, the module combines authoritative loading,
checkpoint reconstruction, observation queries, admission, branch and loop
state, wait/retry settlement, event persistence, terminalization, failure
notification intent, and SQL row mapping.

Do not introduce a generic repository or base store. Extract cohesive internal
modules around existing transaction boundaries, for example:

- authoritative run and checkpoint load;
- persisted observation load and validation;
- ready-admission persistence;
- branch, loop, retry, and wait settlement; and
- terminal run and notification persistence.

Keep the public behavior-named port stable. Move one operation at a time with
the current PostgreSQL integration tests as characterization coverage.

### A-06: Split engine operations without splitting the state machine

- **Severity:** Medium
- **Category:** readability and necessary domain complexity
- **Files:** `packages/workflow-engine/src/operations.ts`,
  `packages/workflow-engine/src/advance-workflow.ts`,
  `packages/workflow-engine/src/checkpoint.ts`
- **Classification:** partially reducible complexity

The engine correctly centralizes deterministic state transitions, but the major
files are large and require broad knowledge to modify. The complexity of joins,
loops, waits, retries, cancellation, and terminal selection is necessary. The
organization around that complexity can improve.

Extract pure internal units for observation parsing, stale-fact validation,
branch-selection observations, loop observations, retry/wait observations,
ready admission, and terminal selection. Keep a single orchestration entry point
and one canonical transition vocabulary. Do not distribute transition authority
among node executors or persistence adapters.

### A-07: Decompose preview and node-attempt persistence by lifecycle stage

- **Severity:** Medium
- **Category:** cohesion and testability
- **Files:** `packages/database/src/preview-execution.ts`,
  `packages/database/src/node-attempt-run-store.ts`
- **Classification:** partially reducible complexity

These modules each combine claim validation, leases, durable dispatch evidence,
input/output persistence, artifacts, terminal facts, cleanup, and reconciliation.
Split private implementation by acceptance, claim/heartbeat, dispatch fencing,
completion, and reconciliation. Preserve one transaction per authoritative
state change and retain the current narrow worker-facing interfaces.

### A-08: Narrow the database package's public capability surface

- **Severity:** Medium
- **Category:** package structure and coupling
- **File:** `packages/database/src/index.ts`
- **Classification:** partially reducible complexity

The root database export is broad, and applications import the package root in
many places. This makes it easier for an API, worker, maintenance, recovery, or
operator role to depend accidentally on a capability outside its responsibility.

Introduce explicit supported export paths organized by runtime responsibility,
such as authoring, execution, maintenance, recovery, and operator capabilities.
This is package-surface narrowing, not a request for additional repository or
service layers. Enforce the intended imports with existing package-boundary lint
rules.

### A-09: Split giant tests by invariant while retaining real failure proofs

- **Severity:** Medium
- **Category:** test readability and maintenance cost
- **Files:**
  `packages/database/test/coordinator-run-store.integration.test.ts`,
  `packages/workflow-engine/test/executable-workflow.test.ts`,
  `apps/worker/test/coordinator-consumer.integration.test.ts`
- **Classification:** should be corrected

These files are approximately 6,364, 4,643, and 4,067 lines. They cover many
behavior families and make test ownership, failure localization, and focused
execution harder.

Divide them by invariant or durable transaction rather than by arbitrary file
size. Reuse typed seed/build helpers, but avoid a large general fixture framework.
Keep process-kill, duplicate-delivery, Redis-loss, and real PostgreSQL scenarios
intact instead of replacing them with mocks.

### A-10: Reconcile the progress tracker with the implemented Phase 7 state

- **Severity:** Medium
- **Category:** documentation and architecture governance
- **File:** `docs/implementation-progress.md`
- **Classification:** harmless runtime drift; process violation

Phase 7 remains marked in progress, which is appropriate while live drills are
unfinished. Several individual unchecked items, however, now coexist with
substantial completed implementations: migrations 0044–0068, dedicated
lifecycle/operator/recovery applications, dual-region ledger and artifact code,
retention and purge coordinators, dashboards, alerts, autoscaling contracts, and
deployment validation.

Review every Phase 7 criterion against its exact acceptance language. Mark only
fully satisfied items complete and add concrete fixed-head evidence. Keep real
load, failover, PITR, and regional restore work incomplete until it has actually
run. This reconciliation should happen as its own documentation checkpoint, not
as an incidental edit during implementation.

### A-11: Reduce readiness implementation brittleness

- **Severity:** Low
- **Category:** compatibility and maintainability
- **File:** `packages/database/src/readiness.ts`
- **Classification:** intentional but brittle

Exact `md5(function.prosrc)` checks provide strong detection of unauthorized
function drift, but they also couple application readiness to the exact textual
form of SQL function bodies. Equivalent formatting or published migration repair
can require synchronized application changes.

Retain migration checksums as the primary immutable authority. Restrict runtime
source hashing to explicitly versioned security-critical functions, document the
update and rollback procedure, and keep prior-head compatibility tests for every
supported rolling release.

### A-12: Replace the remaining production double assertion

- **Severity:** Low
- **Category:** TypeScript safety
- **File:** `apps/worker/src/execution/node-attempt-runtime.ts`
- **Classification:** harmless drift

The preview-store cleanup path uses `as unknown as` to discover a close
capability. Give the dependency an explicit optional close contract or use a
small runtime type guard. The codebase otherwise uses `unknown` and runtime
validation well; this cleanup prevents a local escape hatch from becoming a
pattern.

## Repetition and consistency observations

The repository does not suffer from widespread generic repositories, base
services, or speculative provider factories. Repetition worth removing is
mostly local and mechanical:

- tenant transaction setup and cleanup variants;
- database row-to-domain parsing inside the largest stores;
- repeated release-description and compatibility-selection plumbing;
- repeated test seeding and polling helpers in giant integration suites;
- repeated timeout/abort composition; and
- repeated lifecycle cleanup and error aggregation in standalone applications.

Consolidation is warranted only when the shared code owns a real invariant.
Small wrappers that merely rename another interface should not be introduced.
Timeout and shutdown helpers should be shared only if their abort, cleanup, and
error-preservation semantics are genuinely identical.

## TypeScript assessment

The TypeScript implementation is strong:

- strict compiler settings are enabled;
- production `any` is effectively absent;
- untrusted values are generally parsed through Zod or explicit boundary
  parsers;
- discriminated unions model attempts, outcomes, jobs, commands, and state
  transitions clearly;
- immutable/read-only values are used consistently;
- impossible state is frequently rejected explicitly;
- exhaustive handling is used for bounded vocabularies; and
- browser-safe and server-only package surfaces are deliberately separated.

Future code-quality work should favor simpler named domain types over clever
generics. Branded identifiers are useful at high-risk cross-aggregate seams, but
blanket branding of every string would add noise without proportional safety.

## Architecture rules that currently pass

The following should be preserved during all refactoring:

- PostgreSQL is authoritative for durable workflow, trigger, admission,
  lifecycle, and recovery state.
- Redis and BullMQ carry identifier-only wake-up and delivery messages.
- The workflow engine has no NestJS, ORM, Redis, BullMQ, HTTP, or PostgreSQL
  dependency.
- API controllers delegate to use cases and do not own business transactions.
- Immutable workflow versions and exact executor identities remain pinned.
- Outbox and inbox records make duplicate queue delivery harmless.
- Dispatch evidence precedes external effects where required.
- Unsafe ambiguity becomes `outcome_unknown`; it is not reported as definite
  failure or retried automatically.
- Cancellation and terminal state transitions are monotonic and fenced.
- Waits and retry due times release workers and remain PostgreSQL-authoritative.
- Branch, join, parallel, and loop identities remain deterministic.
- Forced RLS and transaction-local workspace context remain mandatory.
- SSRF controls perform fresh DNS policy checks and address pinning.
- Operator authority remains outside public tenant HTTP endpoints and normal
  queue workers.
- Regional recovery remains fail-closed until control ledgers and artifact
  inventories agree.

## Code that should not be simplified away

The following code is complicated because the domain is complicated. Reducing
its line count is not a sufficient reason to change it:

- checkpoint CAS and gapless run-event sequencing;
- separate coordinator and node-attempt jobs;
- durable dispatch evidence and provider idempotency keys;
- lease fencing and expired-attempt reconciliation;
- immutable compatibility releases and additive-before-subtractive rollout;
- explicit branch ledgers and deterministic joins;
- stable invocation keys for nested loops;
- restricted expression evaluation and bounded JSON handling;
- forced RLS and fail-closed connection-pool hygiene;
- secure HTTP redirect, DNS-rebinding, response-bound, and credential rules;
- dual-region control-ledger agreement;
- verified object deletion and explicit workspace purge progress; and
- provider-specific Slack and Resend uncertainty semantics.

## Recommended order of work

1. Complete real environment load, outage, failover, and restore exercises.
2. Split startup compatibility checks from steady-state readiness.
3. Isolate retention operation failures and prove non-starvation.
4. Reconcile the Phase 7 tracker with exact current evidence.
5. Consolidate identity tenant transaction hygiene.
6. Split coordinator persistence by existing durable transaction boundaries.
7. Split engine operations into pure internal decision units.
8. Decompose preview and attempt persistence by lifecycle stage.
9. Narrow database exports by runtime responsibility.
10. Split the largest tests by invariant.
11. Reduce readiness source-hash brittleness.
12. Remove the remaining production double assertion.

## Completion standard

An item in this audit is complete only when:

- the recommended invariant is implemented without weakening durability,
  security, tenant isolation, recovery, or compatibility;
- the narrowest relevant unit and real-service tests pass;
- failure behavior is tested where the item concerns concurrency, persistence,
  lifecycle, or external effects;
- `docs/implementation-progress.md` is updated when a checkpoint criterion
  changes status; and
- the change is delivered as a coherent, independently reviewable commit.
