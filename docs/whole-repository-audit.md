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
1,227 unit-level tests. Environment-dependent integration, live load, failover,
and regional recovery exercises were inspected but not rerun for this audit.

## Overall assessment

The backend is architecturally sound and unusually rigorous about PostgreSQL
authority, tenant isolation, immutable compatibility, duplicate delivery,
idempotency, dispatch uncertainty, and recovery. The engine remains independent
of NestJS, PostgreSQL, Redis, BullMQ, and HTTP. Redis and BullMQ remain transport
and coordination mechanisms rather than competing durable authorities.

The implementation is not yet as maintainable or operationally proven as the
architecture deserves. The highest-value work is to enforce the replica-lag
write-admission fence required by ADR 015, make readiness inexpensive, isolate
maintenance failures, complete real environment exercises, consolidate tenant
transaction hygiene, and reduce the responsibility size of several core modules
without weakening their correctness guarantees.

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

### A-00: Enforce the PostgreSQL replica-lag write-admission fence

- **Severity:** High
- **Category:** durability, regional recovery, and architecture adherence
- **Files:** `docs/adr/015-production-slo-region-and-recovery.md`, API durable
  write admission, webhook admission, deployment monitoring configuration
- **Classification:** corrected after the audited head; live exercise remains
  tracked by A-03

ADR 015 requires continuous monitoring of the cross-region PostgreSQL replica
and requires durable write admission to pause when replay lag reaches five
minutes, resuming only after lag falls below that bound. The repository does not
currently expose a replica-lag authority to serving processes or consume such a
signal in durable API and webhook admission.

Implement one fail-closed admission module with a small interface shared by all
durable write-entry paths. Its production adapter must consume an authenticated,
fresh, deployment-owned replica-lag signal; tests should use an in-memory
adapter. Stale, unavailable, or over-threshold state must reject new durable
writes without interrupting reads or already-admitted workflow execution. Prove
threshold, recovery, stale-signal, and dependency-failure behavior before the
live regional exercise. The exercise is evidence for this control, not a
substitute for it.

**Resolution (2026-08-28):** migration `0069_regional_write_admission.sql`
adds a production-required, fail-closed PostgreSQL authority. The maintenance
process samples the authenticated configured replica every five seconds and
persists only through a narrow function; shared workflow-run acceptance rejects
new manual, webhook, schedule, and replay starts at or above 300 seconds and on
missing, unavailable, or 15-second-stale evidence. Exact idempotent replay,
reads, and already-admitted execution remain available. Fixed-cardinality
metrics, transition logs, a paging rule, API/webhook retry responses, and real
PostgreSQL threshold/staleness/replay tests cover the locally provable control.
The AWS replication and pager exercise is still open under A-03.

### A-01: Separate startup compatibility validation from steady readiness

- **Severity:** High
- **Category:** operational reliability and performance
- **Files:** `apps/api/src/platform/health/ready.controller.ts`,
  `packages/database/src/database.ts`, `packages/database/src/readiness.ts`
- **Symbols:** `ReadyController.ready`, `WorkspaceDatabase.checkReadiness`,
  `checkDatabaseReadiness`
- **Classification:** corrected after the audited head

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

**Resolution (2026-08-28):** `WorkspaceDatabase` now exposes separate
`checkCompatibility` and `checkReadiness` contracts. API and worker bootstrap run
the complete schema, ownership, RLS, privilege, function, index, migration, and
release audit before serving or consuming. Recurring API and worker probes use a
bounded query for connectivity, PostgreSQL version, migration head, and current
compatibility release, while continuing to check their live Redis, queue,
trigger, artifact, and drain dependencies. A disposable PostgreSQL regression
proves that catalog drift still fails the startup audit but is not repeatedly
rescanned by steady readiness.

### A-02: Isolate unrelated retention and maintenance failures

- **Severity:** High
- **Category:** failure isolation and lifecycle
- **File:** `apps/retention/src/run.ts`
- **Symbol:** `runRetentionWorker`
- **Classification:** corrected after the audited head

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

**Resolution (2026-08-28):** the retention process now supervises explicit
operator-rerun, scheduling, dry-run, enforcement, preview, run-artifact, and
workspace-purge loops independently. Each class owns its consecutive-failure
state and exponential retry delay capped at 30 seconds, emits the existing
bounded failure metric plus structured failure/recovery events, and cannot stop
another class. Ledger and artifact readiness are cached only after success and
are required only by the destructive loops that consume them; their outage no
longer blocks database-only scheduling or dry-run work. Ordering, leases, fences,
and external-I/O sequencing remain inside the existing coordinators.

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
- **Classification:** corrected after the audited head

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

Resolution: identity persistence now delegates workspace access, workspace
creation, and lifecycle commands to `withTenantScopedClient`, including actor
context where the operation is actor-authorized. Global issuer/subject identity
resolution uses the deliberately separate `withPlatformTransaction` entry
point. Both entry points share one private transaction engine with pre-use and
post-commit context checks, tenant-setting read-back, abort-driven connection
cancellation, rollback-error preservation, and contaminated-client destruction.
The former identity-local transaction helper and its divergent cleanup rules
have been removed. Focused real-PostgreSQL coverage exercises the identity
adapter plus tenant and global transaction hygiene, including global context
absence and commit-path contamination disposal.

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

Progress: the coordinator-specific read-only repeatable-read and authoritative
write transaction boundary has moved into
`coordinator-run-store-transactions.ts`. The public store remains unchanged,
and both paths share acquisition, abort cancellation, workspace-context setup,
commit/rollback, and release behavior. This is the first extraction seam for
the operation modules below. The stable public port, results, errors, and
boundary schemas now live in `coordinator-run-store-contract.ts`, avoiding
circular ownership as implementations split. Durable delivery validation,
receipt claim/completion, capacity deferral, mismatch auditing, and delivery
acknowledgement move together in `coordinator-run-store-delivery.ts`; the commit
path reuses those same invariants. Authoritative loading is now isolated in
`coordinator-run-store-observations.ts`: the module owns bounded event paging,
event and output mapping, checkpoint-to-physical-state reconciliation, pending
failure observation, artifact availability, cancellation/deadline validation,
and due-wakeup reconstruction inside the unchanged repeatable-read transaction.
Ready admission, settlement, and terminalization remain to be separated before
A-05 is complete.

The authoritative write operation now lives in
`coordinator-run-store-commit.ts`, leaving `coordinator-run-store.ts` as the
stable public composition root for load, commit, acknowledgement, and close.
The original single write transaction and call ordering are unchanged. The
write module still owns ready admission, branch/loop/retry/wait settlement, and
terminal notification helpers; those internal responsibilities remain the last
A-05 decomposition work.

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

- **Severity:** Low
- **Category:** package structure and coupling
- **File:** `packages/database/src/index.ts`
- **Classification:** design opportunity; no current dependency violation found

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

### A-10: Improve Phase 7 checklist granularity

- **Severity:** Low
- **Category:** documentation and architecture governance
- **File:** `docs/implementation-progress.md`
- **Classification:** documentation usability opportunity

Phase 7 remains marked in progress, and its combined rows correctly remain
unchecked while any required implementation or live-evidence clause is
unfinished. Several individual unchecked items coexist with
substantial completed implementations: migrations 0044–0068, dedicated
lifecycle/operator/recovery applications, dual-region ledger and artifact code,
retention and purge coordinators, dashboards, alerts, autoscaling contracts, and
deployment validation.

For readability, split combined criteria into implementation and live-evidence
sub-items where that does not change the authoritative acceptance standard.
Mark only fully satisfied items complete and add concrete fixed-head evidence.
Keep real load, failover, PITR, and regional restore work incomplete until it has
actually run.

### A-11: Reduce readiness implementation brittleness

- **Severity:** Low
- **Category:** compatibility and maintainability
- **File:** `packages/database/src/readiness.ts`
- **Classification:** intentional but brittle

Exact `md5(function.prosrc)` checks provide strong detection of unauthorized
function drift, but they also couple application readiness to the exact textual
form of SQL function bodies. Equivalent formatting or published migration repair
can require synchronized application changes.

After A-01 moves the full audit out of recurring probes, retain exact hashes for
the security- and compatibility-critical functions unless a later ADR explicitly
reassigns that authority. Document the synchronized update and rollback
procedure, inventory the intentionally hashed functions, and keep prior-head
compatibility tests for every supported rolling release.

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

## Overabstraction and indirection audit

The production source contains approximately 327 interfaces, 284 classes, and
146 `create*` factories. Raw counts do not prove overengineering: this system has
several genuine boundaries between browser contracts, applications, engines,
persistence, queues, object storage, providers, and operator roles. The review
classified the major abstraction families as follows.

| Abstraction family | Assessment | Reason |
| --- | --- | --- |
| Engine persistence ports | Justified | Permit pure deterministic decisions and real persistence adapters without infrastructure leakage |
| Node SDK definition/executor contracts | Justified | Preserve browser/server separation and immutable compatibility |
| Queue producer/consumer contracts | Justified | Isolate transport from PostgreSQL authority and support failure injection |
| Provider HTTP, connection, and artifact capabilities | Justified | Own dispatch fencing, SSRF, credentials, and bounded values |
| Operator, recovery, and lifecycle executables | Justified | Enforce privilege and deployment separation |
| Telemetry interfaces around each slice | Partially reducible | Some provide useful test seams; others repeat nearly identical counter/histogram/tracer shapes |
| NestJS runtime holder classes | Partially reducible | Several classes exist primarily to expose a composed runtime through dependency injection |
| `create*Database` factories returning very large object literals | Unnecessarily deep in hotspots | Factory plus giant object literal hides multiple durable operations inside one lexical scope |
| Repeated application resource/dependency objects | Partially reducible | Explicit composition is good, but some objects have become broad service locators |
| Duplicate transaction and cleanup helpers | Unnecessary | They repeat correctness rules and have already drifted semantically |

There is no evidence of a repository-wide generic repository, generic service,
base-controller hierarchy, speculative provider framework, or inheritance-heavy
domain model. The dominant abstraction problem is not too many layers between a
caller and behavior. It is that several factories and dependency objects have
grown broad while still presenting themselves as one cohesive seam.

The preferred simplification is therefore to deepen cohesive modules and narrow
their public contracts. It is not to remove the ports that protect the engine,
tenant boundary, dispatch authority, or operator boundary.

## Symbol-level readability and size

File size alone understates the concentration of logic. A brace-span inventory,
followed by source inspection of the largest results, found these production
symbols or returned operation objects:

| Symbol or operation | Approximate span | Assessment |
| --- | ---: | --- |
| `createNodeAttemptRunStore` | 1,181 lines | Unnecessarily broad factory; necessary operations need internal modules |
| `createConnectionDatabase` | 1,129 lines | Broad persistence factory containing several connection lifecycles |
| `createCoordinatorRunStore` | 1,094 lines | Broad factory with multiple durable transaction responsibilities |
| `advanceWorkflowFromSchedulerState` | 1,038 lines | Necessary state-machine complexity, but internally reducible |
| `commitAdvancePlan` implementation | 758 lines | High-risk transaction with too many locally interleaved concerns |
| `createWorkspacePurgeCoordinator` | 579 lines | Mostly justified destructive workflow; stage organization can improve |
| `createIdentityWorkspaceDatabase` | 506 lines | Multiple global and tenant responsibilities in one adapter |
| `createFailureNotificationStore` | 492 lines | Partially reducible persistence lifecycle |
| `parseObservations` | 432 lines | Pure but difficult to review; split by observation family |
| node-attempt `complete` operation | 431 lines | High-risk terminal transaction; should be decomposed internally |
| `createWebhookTriggerDatabase` | 348 lines | Manageable but combines management and ingress concerns |
| `createNodeAttemptHandler` | 327 lines | Necessary dispatch/heartbeat race logic; extract only pure setup/classification |
| workflow `publishWorkflow` operation | 325 lines | Necessary transaction with reducible mapping and validation setup |
| node-attempt `loadInputs` operation | 319 lines | Multiple input-source and control-state responsibilities |
| `createPreviewAttemptHandler` | 256 lines | Complex but closely mirrors production attempt semantics |
| `executeNodeAttempt` | 234 lines | Appropriate engine-level orchestration; keep central |
| secure HTTP `executeWithBody` | about 220 lines | Necessary security-sensitive linear flow; do not fragment excessively |

The approximate spans are navigation evidence rather than a lint threshold. SQL
template literals and returned object methods make automatic symbol measurement
imperfect. Each listed hotspot was checked against its actual source structure.
The problem is clearest in factories returning one enormous frozen object: the
public API looks small, but the implementation remains a thousand-line closure
with shared local state and helpers.

No universal maximum function length should be introduced. A 200-line security
protocol can be easier to verify than ten mutually dependent helpers. Refactoring
is warranted where a symbol owns several durable transactions, state machines,
or unrelated lifecycle stages.

## Cross-phase style and pattern drift

Early and late code share the same broad architectural values, but implementation
style has evolved.

| Concern | Earlier pattern | Later pattern | Assessment |
| --- | --- | --- | --- |
| Tenant transactions | Local transaction helpers with ad hoc cleanup | Shared fail-closed client primitive with read-back and abort cancellation | Earlier identity adapter should converge |
| Runtime validation | Hand-written record parsing mixed with Zod | Strict Zod at transport/config boundaries plus explicit trusted internal types | Both can be valid; ownership should be documented consistently |
| Composition | Smaller NestJS providers and direct factories | Large immutable dependency/resource objects and runtime holder classes | Later code is explicit but can resemble a service locator |
| Errors | Many small nominal error classes and string messages | More discriminated outcome unions and bounded error codes | Prefer unions for expected outcomes, classes for exceptional boundaries |
| Telemetry | Slice-specific meter/tracer facades | Shared observability packages plus additional slice facades | Consolidate repeated facade shapes without centralizing event vocabulary |
| Compatibility naming | Phase-numbered constants and engine labels | Product/behavior-oriented lifecycle and release vocabulary | Retained names are compatible but increasingly historical |
| Persistence adapters | One large factory per vertical slice | Dedicated coordinators for retention, purge, ledger, and operator work | Later operation-oriented modules are easier to reason about |
| Cleanup | Direct sequential close calls | `AggregateError`, bounded cleanup, and preservation of primary failure | Earlier standalone paths should adopt the stronger pattern where semantics match |

This is not a split into two incompatible codebases. Dependency direction,
immutability, validation, and explicit authority remain consistent. Drift is
concentrated in transaction hygiene, error/result style, cleanup behavior,
telemetry facade shape, and phase-coded names.

## Dead, obsolete, and retained compatibility audit

Strict TypeScript and package builds did not expose unreachable imports or unused
locals. No production abstraction was proven dead strongly enough to recommend
immediate deletion. A repository-wide exported-symbol reference scan did identify
review candidates, but an export referenced only once inside the monorepo may be
an intentional public package contract and is not proof of dead code.

The following areas need explicit retirement decisions:

- phase-coded runtime values such as `phase3-engine-v1` remain in coordinator,
  node-attempt, trigger, schedule, replay, and retained-fixture paths;
- comments and constants in `packages/node-catalog/src/registry.ts` still describe
  Phase 4 cohorts even though later providers and triggers are active;
- retained workflow V1 parsing and checksum logic is intentionally required for
  historical immutable rows and must not be deleted without a data inventory and
  supported-retention decision;
- compatibility release variants and predecessor cohorts are required for
  rolling releases, but the supported set should be generated or inventoried so
  retired cohorts cannot remain accidentally live forever;
- browser/client contract exports with no internal consumer may be externally
  supported and require an API compatibility decision before removal; and
- one-reference exports such as `safeParseWorkflowGraphDraft`,
  `EMPTY_DEFINITION_CATALOG_FINGERPRINT_V1`, and several HTTP response schemas
  should be checked against generated artifacts and intended external imports.

Create a compatibility-retirement inventory rather than deleting these items as
ordinary dead code. For each candidate record its persisted data dependency,
external package status, last supported release, and removal test. The audit
classifies current retained compatibility as intentional and justified, with
documentation and inventory debt rather than confirmed dead machinery.

## TypeScript elegance, not only correctness

The code is strongly typed and usually expressive, but elegance varies by layer.

Strong examples include discriminated queue jobs, attempt outcomes, operator
commands, engine observations, immutable release descriptions, and Zod-inferred
boundary values. These types make invalid state difficult to represent and allow
control flow to narrow naturally. Generic usage in the node SDK earns its cost
because it connects definition config, input, executor, and output schemas.

Less elegant areas include:

- large dependency and resource objects whose types are accurate but do not
  reveal smaller cohesive subsystems;
- long return-object factories where type inference confirms correctness while
  hiding the implementation's responsibility size;
- repeated structurally identical telemetry interfaces;
- some parallel runtime and persisted representations that require mapping code
  in multiple packages;
- numerous small nominal error classes where a discriminated expected-error
  result would sometimes read more directly; and
- compatibility options with several optional fields whose legal combinations
  are enforced at runtime instead of represented as a discriminated union.

The implementation is therefore more than merely type-correct, but it is not
uniformly elegant. The engine and contracts make especially good use of unions
and readonly data. Persistence composition relies more heavily on broad object
shapes and runtime checks. Improvements should simplify legal-state modeling and
module boundaries rather than add advanced conditional or mapped types.

## Test cost and harness assessment

Production source and test size are both large:

| Area | Production lines | Test lines | Observation |
| --- | ---: | ---: | --- |
| `packages/database` | about 31,590 | about 32,400 | Test code exceeds production code; strong confidence but high fixture cost |
| `apps/worker` | about 7,863 | about 20,765 | Process, transport, provider, and recovery matrices dominate maintenance cost |
| `apps/api` | about 14,120 | about 13,141 | Broad controller/use-case/integration coverage |
| `packages/workflow-engine` | about 7,697 | about 6,791 | Dense deterministic scenario coverage is justified |
| `packages/artifact-store` | about 3,215 | about 3,503 | Dual-region and safety behavior justify above-average test volume |

The current unit suite is fast for its size: all 1,226 tests completed locally in
roughly 16 seconds of wall-clock orchestration, with the API suite around seven
seconds and worker suite around six seconds. The expensive part is the real
service and destructive matrix, not unit assertions.

High-cost harness concerns are:

- giant integration files combine many scenarios and repeat SQL seeding;
- some suites require run-last ordering or disposable database discipline;
- phase-specific environment flags make it possible to mistake a skipped suite
  for executed evidence outside CI;
- process-kill fixtures are valuable but bespoke, increasing change cost;
- polling helpers and timing tolerances are repeated across worker suites; and
- assertion counts in the tracker are snapshots rather than generated current
  evidence.

Do not reduce confidence by replacing real PostgreSQL, Redis, BullMQ, object
storage, or process-death tests with mocks. Reduce cost through per-suite
disposable databases, shared typed seed primitives, generated execution reports,
explicit skip summaries, scenario sharding, and invariant-oriented file splits.

## Ranked complexity hotspots

| Rank | Hotspot | Classification | Why |
| ---: | --- | --- | --- |
| 1 | Coordinator persistence and `commitAdvancePlan` | Partially reducible | Central durable transaction mixes many observation and settlement paths |
| 2 | Workflow advancement state machine | Necessary complexity | Branch, loop, join, retry, wait, cancellation, and terminal truth meet here |
| 3 | Node-attempt persistence | Partially reducible | Claim, heartbeat, dispatch, output, retry, and completion share one factory |
| 4 | Node-attempt handler race protocol | Necessary complexity | Must reconcile transport, lease, heartbeat, cancellation, dispatch, and completion |
| 5 | Compatibility release construction and retirement | Necessary complexity | Immutable execution and rolling release correctness depend on it |
| 6 | Checkpoint parsing and reconstruction | Necessary complexity | Accepts persisted JSON and protects deterministic recovery |
| 7 | Workspace purge | Necessary complexity | Ordered database, object, secret, and tombstone deletion must be resumable |
| 8 | Control-ledger reconciliation and restore gate | Necessary complexity | Dual-region agreement and restore safety are intrinsically difficult |
| 9 | Connection persistence | Partially reducible | Creation, rotation, testing, secrets, health, and idempotency share a large factory |
| 10 | Preview persistence and cleanup | Partially reducible | Mirrors production guarantees while remaining isolated and short-retained |
| 11 | Secure HTTP | Necessary complexity | SSRF, rebinding, redirects, bounds, aborts, and dispatch uncertainty interact |
| 12 | Database readiness | Unnecessarily complex at probe time | Valuable checks are composed into one recurring catalog audit |
| 13 | Retention worker orchestration | Unnecessarily coupled | Unrelated maintenance classes share one failure domain |
| 14 | Node SDK registry/release implementation | Partially reducible | Correct generic contract, but registry and release files have accumulated duties |
| 15 | API/worker runtime composition | Partially reducible | Broad dependency objects and holder classes obscure sub-runtime cohesion |
| 16 | Giant database integration harness | Unnecessarily difficult to navigate | Confidence is high, but scenarios and seed logic are concentrated |
| 17 | Giant worker coordinator harness | Unnecessarily difficult to navigate | End-to-end value is real; fixture organization is costly |
| 18 | Observability facades | Partially reducible | Event ownership is good; repeated interface shapes add noise |

## Post-Phase 7 refactor portfolio

This order assumes release-blocking operational evidence is completed first.

| Rank | Refactor | Impact | Risk | Effort | Reason |
| ---: | --- | --- | --- | --- | --- |
| 1 | Split startup compatibility validation from steady readiness | High | Medium | Medium | Removes probe load and readiness flapping without weakening startup gates |
| 2 | Isolate retention operation failures | High | Medium–High | Medium | Prevents one dependency outage from stopping unrelated destructive work |
| 3 | Consolidate tenant transaction hygiene | High | Medium | Medium | Removes security-sensitive duplicated behavior |
| 4 | Extract coordinator persistence by durable transaction | High | High | High | Reduces the largest maintenance and correctness hotspot |
| 5 | Extract pure engine observation and settlement units | High | High | High | Makes the central state machine reviewable without distributing authority |
| 6 | Decompose node-attempt persistence by lifecycle | High | High | High | Separates claim, dispatch, input, and completion invariants |
| 7 | Decompose connection persistence by lifecycle | Medium–High | Medium–High | Medium | Reduces a thousand-line factory and secret-handling change radius |
| 8 | Decompose preview persistence by lifecycle | Medium–High | High | Medium | Keeps production-equivalent guarantees understandable |
| 9 | Narrow database exports by runtime role | Medium–High | Medium | Medium | Prevents accidental cross-role capability coupling |
| 10 | Split giant integration suites by invariant | Medium | Medium | Medium | Improves ownership and failure localization while preserving real tests |
| 11 | Create a compatibility-retirement inventory and gate | Medium | Medium | Medium | Prevents historical cohorts and phase-coded paths from becoming permanent |
| 12 | Normalize expected-error unions versus exceptional classes | Medium | Medium | Medium | Improves TypeScript readability and consistent control flow |
| 13 | Consolidate truly identical telemetry facade shapes | Medium | Low–Medium | Medium | Removes repeated plumbing while preserving event ownership |
| 14 | Standardize bounded cleanup and primary-error preservation | Medium | Medium | Low–Medium | Converges early and late lifecycle quality |
| 15 | Generate test execution and tracker evidence | Medium | Low | Medium | Makes skipped suites, runtimes, counts, and fixed-head evidence mechanical |

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
