# `@pertexo/database` implementation and architecture audit

## Review identity and conclusion

- **Audited implementation commit:**
  `7e4b37840a2b86c591046e16f1de834e8da2db79`
- **Audited implementation tree:**
  `8481ebf86f4b36ff70687f86a2bb7933a00d65b8`
- **Production scope:** all 140 TypeScript source files, 33,154 physical source
  lines, all 75 SQL migrations, and 12,978 physical migration lines.
- **Test scope:** all 135 files in `packages/database/test` (134 TypeScript plus
  one SQL fixture), the package's Vitest configurations, the nine testing
  entry/support modules under `src`, direct consumers in every application,
  package and repository checks, CI, the implementation plan, and applicable
  ADRs.
- **Tooling scope:** `package.json`, `raw-sql-table-registry.json`, both
  TypeScript configurations, and all three Vitest configurations (7 files and
  264 physical lines).
- **Granular certification:** every one of the package's 357 tracked files and
  80,829 physical lines was included: 140 production files/33,154 lines, 135
  test and fixture files/34,433 lines, 75 migrations/12,978 lines, and 7 local
  package/tooling files/264 lines. Every export and meaningful internal
  callable was assessed for responsibility, callers, invariants, control and
  error flow, resource behavior, naming, readability, duplication, reuse,
  abstraction depth, test evidence, and applicable security, tenancy,
  concurrency, cancellation, performance, migration, and operational risk.
  The findings below are the complete identified set, not a top-N selection.
- **Architecture sources:** the authoritative backend plan; ADRs 002, 003,
  005-007, 010-016, 021-022, 025-027, and 029; the PostgreSQL operations and
  schema guidance used by this review; the complexity-retention register; and
  the raw-SQL table registry.
- **Audit status:** granularly certified for the pinned tree.
- **Implementation status:** four high-priority architectural/production-
  readiness issues, nine medium-priority performance, assurance, and
  maintainability issues, three low-priority cleanup/control issues, and one
  external production-evidence obligation remain open.

This package is the durable center of the platform and is substantially better
than its size suggests. It correctly treats PostgreSQL as authoritative, keeps
tenant scope explicit, uses forced RLS and narrow runtime roles, persists
state-machine transitions atomically, validates hostile JSON at storage
boundaries, generates UUIDv7 identities centrally, and tests concurrency,
fencing, migration, RLS, and replay behavior against real PostgreSQL. Its role-
specific package entrypoints are a good architectural boundary. The 320 fresh
integration assertions are meaningful behavior tests, not tests written only
to inflate a count.

The package is not yet ideal for a large production deployment. Repository
factories usually create private pools, so application composition multiplies
the configured pool maximum instead of sharing one enforceable process budget.
Several retention, purge, and control-ledger paths hold PostgreSQL transactions
and locks while awaiting network services, and explicitly disable the idle-in-
transaction backstop. The migration runner applies every pending migration in
one transaction, which cannot support concurrent index creation and makes
large historical backfills inconsistent with the plan's bounded, resumable
online-migration discipline. These are architecture findings, not style nits.

The written TypeScript is generally precise and defensive: no production
`any`, `@ts-ignore`, `TODO`, `FIXME`, or `HACK` markers were found, and the
static import graph has no runtime cycle. Readability is reduced by long object-
literal factories, type-only cycles between composition roots and child
modules, repeated validation vocabulary, and large transaction scripts whose
error outcomes are sometimes collapsed to `released`. Refactoring must preserve
transaction order and database invariants; splitting files merely to reduce
line counts would make several modules worse.

## Evidence collected

The review combined complete production, test, fixture, migration, package,
and local-tooling file reading with export/internal-callable inventories,
direct-consumer tracing, implementation-plan and ADR comparison, source and
migration hygiene analysis, package build/typecheck/lint/tests, real-service
PostgreSQL integration tests, enforced and full-source V8 coverage, schema and
dependency checks, and focused capacity/architecture probes. The package diff
against the audited implementation commit is empty, so the detailed file and
callable conclusions still describe the exact current implementation.

| Check | Result |
| --- | --- |
| `pnpm --filter @pertexo/database test` | 60 files and 175 tests passed |
| `pnpm --filter @pertexo/database test:integration` | 63 files and 320 real-PostgreSQL tests passed in 63.42 s |
| Enforced selected-source coverage | 96.36% statements, 95.38% branches, 100% functions, 97.97% lines |
| Ad hoc full `src/**/*.ts` unit execution | 23.08% statements, 14.71% branches, 22.94% functions, 23.31% lines |
| Package build and typecheck | Passed in the repository pre-push gate |
| Repository format, lint, dependency, schema, complexity, duplication, contract, and type checks | Passed |
| Root uncovered-risk report | 116 reviewed and 0 unreviewed branches in the selected repository cohort |
| Schema ownership check | 67 migration-owned application tables: 48 Drizzle-typed and 19 registered raw-SQL tables |
| Migration inventory | 75 ordered migrations; 102 normal indexes; no concurrent index lane |
| Import graph | No runtime cycles; several erased type-only cycles at composition roots |
| Source hygiene scan | No production `any`, suppression directive, or TODO/FIXME/HACK marker |
| Baseline package diff | Empty against the audited implementation commit |
| Pull-request CI immediately before this audit commit | All 14 reported checks passed, including integration, persistence unit tests, coverage, quality, recovery, image, dependency review, and CodeQL; the audit commit starts a fresh run |

The two coverage rows measure different things. CI's high percentage covers
only `src/tenant-access/workspace.ts`. The low full-source row instruments all
production TypeScript but executes only the unit suite; it does not credit the
large integration suite. Neither number is package-wide unit-plus-integration
coverage. That missing combined measurement is DB-006, not evidence that only
23% of database behavior is tested.

CI currently requires at least 288 database integration assertions; the fresh
run produced 320. The minimum is a regression floor, not the actual test count.
Development-host durations are diagnostic rather than production SLOs.

## Evidence-based scorecard

Scores summarize the pinned tree, not an industry certification. A high score
does not close a listed finding, and an external-evidence gap cannot be solved
by adding local unit tests.

| Area | Score | Evidence behind the score |
| --- | ---: | --- |
| Correctness and durable semantics | 8.6/10 | Strong transactions, CAS, leases, fences, idempotency, and real-service tests; persisted-fact capacity drift remains a confirmed defect |
| Security and tenancy | 9.1/10 | Forced RLS, `SET LOCAL`, fail-closed cleanup, least-privilege readiness, role separation, secret indirection; production role/grant drift is still an operating control |
| Architecture and ownership | 8.1/10 | PostgreSQL authority and role entrypoints are clear; private pool ownership and network I/O inside locked transactions are material seams |
| Readability and TypeScript craft | 7.7/10 | Precise types, bounded validation, strong names; long transaction factories, type cycles, and repeated schemas increase review cost |
| Reuse and abstraction quality | 7.8/10 | Deep tenant transaction and persistence modules have high leverage; pool/config/type contracts are not consistently centralized |
| Test quality | 8.7/10 | 320 useful PostgreSQL assertions cover failure and concurrency paths; source-to-risk and combined coverage evidence are incomplete |
| Performance and scalability readiness | 6.8/10 | Bounded pages and useful indexes exist; pool multiplication, per-row writes, 64-row fact paging, and no representative query-plan gate remain |
| Migrations and schema evolution | 7.2/10 | Checksums, retained-head upgrades, and forward repair are strong; one giant transaction cannot implement the documented online strategy |
| Observability and operations | 7.3/10 | Pool/query/transaction/lock metrics and exhaustive readiness exist; background errors and role attribution lose information, external restore/capacity proof is open |
| Plan and ADR compliance | 8.2/10 | Most persistence, RLS, state-machine, and recovery requirements are implemented; migration and connection-budget requirements are only partially met |
| **Overall engineering assessment** | **8.0/10** | A strong correctness-oriented foundation that needs production-scale resource, migration, performance, and assurance work before it should be called complete |

## Architecture, ownership, and dependency direction

### Public Interfaces

The package intentionally has no broad production root export. Seven explicit
subpaths separate authority and process roles:

- `./api` exposes identity/workspace, workflow authoring and run reads,
  connections, failure destinations, schedules, webhooks, and API-safe errors;
- `./execution` exposes worker and dispatcher stores, execution transitions,
  preview operations, wakeup scanners, artifacts, trigger reconciliation, and
  execution readiness;
- `./lifecycle` exposes only lifecycle-command configuration and coordination;
- `./maintenance` exposes retention, artifact cleanup, regional lag,
  transient-data reap, and workspace purge;
- `./operator` exposes the operator command ledger and its configuration;
- `./recovery` exposes the control-ledger reconciliation coordinator; and
- `./testing` deliberately exposes the broad fixture, migration, raw schema,
  and internal test surface.

This is good Interface design. API code cannot accidentally import worker-only
mutation capabilities through its declared package subpath, and privileged
maintenance/operator operations are visibly separate. The testing wildcard
barrels are acceptable because the package comment explicitly forbids their
production use and dependency checks enforce production entrypoints.

`createDatabasePool` is exported through `./execution` because the worker's
database module needs it. That low-level resource seam should become the common
composition primitive rather than coexist with dozens of factories that always
create their own pool. The desired Interface is one role-owned runtime/pool per
process, passed to narrower repositories that do not own process capacity.

### Dependency direction and integration seams

Database code depends on PostgreSQL/Drizzle, Zod, UUID generation, cron parsing,
OpenTelemetry, and workflow-model validation. It does not import NestJS, Redis,
BullMQ, API controllers, worker orchestration, or provider SDKs. Applications
construct adapters and pass in external ledger/object-store ports. This follows
the modular-monolith plan: applications know persistence; persistence does not
know application frameworks.

The control ledger and object store are intentionally outside PostgreSQL, but
their calls are made from several open database transactions. That preserves a
carefully locked comparison point, yet creates a distributed-operation seam
whose resource cost is hidden inside a database repository. The correct long-
term abstraction is a durable intent/lease/fence state machine: prepare in a
short transaction, perform external I/O without a database lock, then complete
or reconcile in another fenced transaction.

The static graph has no runtime cycle. Type-only cycles exist where
`workflow-authoring.ts`, coordinator, node-attempt, failure-notification,
operator, and identity composition roots export types that their child
implementations import while the roots also import those children. JavaScript
execution is safe because the imports erase, but ownership is inverted. Stable
contracts belong in leaf-neutral `*-contract.ts` modules.

### Data model and PostgreSQL authority

The implementation follows the plan's central rules:

- PostgreSQL owns runs, checkpoints, attempts, schedules, outbox/inbox,
  compatibility state, retention, and operator truth;
- tenant-owned records carry `workspace_id` and repositories require tenant
  scope even where IDs are globally unique;
- tenant transactions set and verify `app.workspace_id` with `SET LOCAL`;
- runtime roles do not own tables and readiness verifies their grants and lack
  of `BYPASSRLS`/superuser authority;
- mutable drafts and current pointers are separated from immutable versions and
  facts;
- statuses use checked text rather than PostgreSQL enums;
- large/variable payloads use bounded JSONB while relational identities,
  constraints, and indexes remain modeled; and
- queue messages are transport hints backed by durable outbox/inbox state.

On the disposable migrated database, 62 tenant tables had enabled and forced
RLS. Thirteen global or function-only authority tables intentionally lacked
RLS: identity/workspace roots, OIDC transactions, compatibility authority,
operator command truth, the outbox fairness cursor, and regional write
admission. Their safety relies on table ownership, withheld grants, security-
definer functions, and readiness checks. That is deliberate, but it must remain
an explicit registry/invariant rather than an assumption.

The 48 Drizzle tables provide typed transaction access. Nineteen function-owned
tables are listed in `raw-sql-table-registry.json` with owner, access roles, RLS
classification, and rationale. The schema check proves name ownership and
forced-RLS declarations, not full column/type/constraint/index equivalence.
DB-012 records the remaining assurance gap without demanding that every
function-only table be mechanically duplicated in Drizzle.

## Complete production-code review

Every production TypeScript file is named below. “Keep” means no current issue
was found beyond a package-level finding explicitly referenced in the row.

### Package roots, configuration, migration runner, and platform

| File | Review |
| --- | --- |
| `api.ts` | Explicit API-authority barrel; clear capability grouping and no wildcard production export. Keep. |
| `execution.ts` | Explicit worker/dispatcher barrel with a larger but coherent operational surface. Low-level pool export should support shared composition under DB-002. |
| `lifecycle.ts`, `maintenance.ts`, `operator.ts`, `recovery.ts` | Small role-owned barrels accurately mirror separate deployment credentials and responsibilities. Keep. |
| `testing.ts` | Broad test-only aggregation is intentionally separated and documented. Keep production import enforcement. |
| `database.ts` | Deep workspace transaction facade; redundant no-op pool error listener and private pool ownership are covered by DB-002/DB-007. |
| `config.ts` | Strict URL, role, environment, and pool bounds are useful. Repeated role-specific environment schemas are safe but verbose; see DB-014. No statement/lock/transaction defaults are carried; see DB-010. |
| `migrate.ts` | Minimal CLI adapter with one configuration parse and one runner call. Keep. |
| `migrations.ts` | Ordered/checksummed, role-verified, advisory-locked migration runner with safe identifier quoting. The all-pending single transaction and historical checksum exceptions are DB-004/DB-016. |
| `platform/persisted-id.ts` | One UUIDv7 owner for application-generated persisted identities. Deep, small, and correct. |
| `platform/postgres-telemetry.ts` | Valuable transparent query/transaction/pool/lock instrumentation. Silent pool/monitor errors and inferred role/monitor sharing limitations are DB-007/DB-015. |
| `platform/readiness.ts` | Aggregates schema head, roles, RLS, grants, functions, compatibility, and serving gates. Long by necessity and fail-closed. Keep exact drift checks generated from one vocabulary where possible. |
| `platform/readiness-probe.ts` | Parses the large SQL probe into named booleans and exact failure messages. Cohesive despite size. |
| `platform/readiness-probe-sql.ts` | Concatenation seam for split SQL literals. Keep. |
| `platform/readiness-probe-1.sql.ts`, `platform/readiness-probe-2.sql.ts`, `platform/readiness-probe-3.sql.ts`, `platform/readiness-probe-4.sql.ts` | Large static catalog proofs split to satisfy source limits. They deliberately verify expected unvalidated constraints as well as RLS/grants/functions. Generated/manifest-backed construction would reduce manual drift, but current behavior is strongly tested. |

### Drizzle schema modules

| File | Review |
| --- | --- |
| `schema/app-schema.ts` | Single `app` namespace owner. Keep. |
| `schema.ts` | Explicit aggregate and `databaseSchema` composition. The typed model is intentionally partial; see DB-012. |
| `schema/foundation.ts` | Users, auth identities, sessions, workspaces, memberships, audit, usage, and RLS probe definitions reflect core constraints and indexes. Keep. |
| `schema/authoring.ts` | Workflow/draft/version/integration-usage/trigger model is cohesive. Publication query behavior, not these definitions, is the issue in DB-008. |
| `schema/compatibility.ts` | Immutable compatibility releases, preactivation checks, approvals, current pointer, and activation history are well separated. Keep. |
| `schema/connections.ts` | Connection metadata, immutable secret versions, and event history correctly avoid plaintext secret storage. Keep. |
| `schema/execution.ts` | Runs, events, checkpoints, node runs/attempts, and previews encode durable execution vocabulary. Index count is high on write-heavy tables; monitor with workload evidence under DB-011 rather than deleting speculatively. |
| `schema/execution-support.ts` | Artifact links and idempotency records are coherent support entities. Keep. |
| `schema/transport.ts` | Artifacts, outbox, inbox, and transport-security facts model durable transport correctly. Keep. |
| `schema/triggers.ts` | Webhook secrets/endpoints/deliveries/replay and schedule occurrences make replay and lease state relational. Keep. |
| `schema/retention.ts` | Control projection, legal hold, audit facts, retention batches, and schedule state correctly expose maintenance truth. Keep. |

### Tenant access and identity

| File | Review |
| --- | --- |
| `tenant-access/workspace.ts` | Exemplary deep module: canonical workspace parsing, pooled-context scrub before/after use, transaction-local scope, readback verification, cancellation-driven client destruction, rollback, and fail-closed cleanup. This is the selected coverage cohort and should remain the common transaction engine. |
| `tenant-access/identity-workspace.ts` | Cohesive identity/workspace facade with atomic membership and lifecycle rules. Its long factory mostly composes methods; move shared types out to remove child/root type cycles under DB-013. |
| `tenant-access/identity-workspace-rows.ts` | Central row projections and strict mapping reduce column drift. Keep. |
| `tenant-access/identity-workspace-support.ts` | Bounded safe metadata and common parsing are justified reuse. Keep. |
| `tenant-access/identity-workspace-identity-store.ts` | Provider identity resolution/linking handles uniqueness conflicts deliberately. Type ownership should move from the root contract. |
| `tenant-access/identity-workspace-session-store.ts` | Session issue/read/revoke behavior is narrow and hashes rather than stores bearer tokens. Keep. |
| `tenant-access/identity-workspace-errors.ts` | Small stable conflict/lifecycle errors. Keep. |
| `tenant-access/oidc-login-transactions.ts` | Sealed, expiring, single-use browser-bound OIDC state with capacity control is a strong boundary. It creates another private pool and repeats validation vocabulary; DB-002/DB-014. |
| `tenant-access/testing.ts` | Purpose-specific test exports avoid exposing raw internals to production subpaths. Keep. |

### Workflow authoring and compatibility

| File | Review |
| --- | --- |
| `authoring/workflow-authoring.ts` | Deep facade for create/read/list/draft/publish coordination, compatibility selection, idempotency, and transaction scope. Long factory is readable in domain stages; root/child type ownership is DB-013. |
| `authoring/workflow-authoring-drafts.ts` | Revision-CAS draft replacement and error mapping are appropriately isolated. Keep. |
| `authoring/workflow-authoring-reads.ts` | Bounded cursor reads and detail assembly are clear. Keep explicit workspace predicates. |
| `authoring/workflow-authoring-rows.ts` | Shared selections and strict row decoders have high leverage. Keep. |
| `authoring/workflow-publication.ts` | Correct lock/compile/persist/project/finalize transaction, but reads all retained versions and writes trigger projections one row at a time; DB-008. |
| `authoring/workflow-authoring-errors.ts` | Stable repository errors are small and useful. Keep. |
| `authoring/testing.ts` | Exposes publication seams/hooks only to tests. Keep. |
| `compatibility/compatibility-release.ts` | Exact epoch/fingerprint/current-target-retained release selection and row validation are deep and fail-closed. Keep. |
| `compatibility/compatibility-release-readiness.ts` | Narrow serving-readiness adapter. Private pool ownership is DB-002. |
| `compatibility/compatibility-release-maintenance.ts` | Transactional preactivation/activation maintenance with rollback is coherent. Private pool and absent global query timeout fall under DB-002/DB-010. |
| `compatibility/persisted-workflow-checkpoint.ts` | Strict V1/V2 persisted checkpoint serialization, ordering, identity and size checks protect the engine seam. Shared capacity/timestamp contracts still drift across packages; DB-001. |
| `compatibility/testing.ts` | Correctly exposes compatibility parsers/maintenance only for focused tests. Keep. |

### Connection persistence

| File | Review |
| --- | --- |
| `connections/connections.ts` | Role-specific API/worker façades compose narrower capabilities. Good external Interface; pool construction should be injected under DB-002. |
| `connections/connection-persistence.ts` | Common SQL, validation, authorization, codecs, and a 63-symbol internal contract are too wide for one vocabulary owner. Split contract/codecs/transaction helpers by capability under DB-013, without fragmenting public APIs. |
| `connection-management-persistence.ts` | Create/rename/disable/rotate lifecycle and conflict mapping are cohesive. Keep transaction semantics. |
| `connection-secret-persistence.ts` | Immutable encrypted secret-version persistence is correctly separated from metadata. Keep. |
| `connection-resolution-persistence.ts` | Worker resolution returns sealed secret material through a narrow authority. Keep. |
| `connection-test-persistence.ts` | Fenced test claims/completion and concurrency conflict behavior are useful. Keep. |
| `connection-health-persistence.ts` | Health updates are narrow and avoid widening secret access. Keep. |
| `workflow-integration-usage.ts` | Bounded impact lookup for connection/provider operations is a good cross-feature seam. Private pool ownership is DB-002. |
| `connections/testing.ts` | Deliberately exposes narrower persistence builders for integration tests. Keep. |

### Execution acceptance, transport, and read APIs

| File | Review |
| --- | --- |
| `execution/execution-acceptance.ts` | Atomic idempotency, regional admission, quota reservation, run/checkpoint/event/outbox creation, and lifecycle rejection are correctly colocated because partial success would be unsafe. Its API and preview sibling share structure but have different authorities; keep separate unless a genuinely deeper transaction primitive emerges. |
| `execution/preview-execution-acceptance.ts` | Preview-specific admission enforces expiry, source-run access, artifact ownership, and isolated state. Similarity to production acceptance is intentional policy duplication, not a blind extraction target. |
| `execution/workflow-run-api.ts` | Workspace-scoped run detail/list/cancel surface is bounded and role-correct. Private pool ownership and timeout policy are DB-002/DB-010. |
| `execution/workflow-run-cancellation.ts` | Durable cancellation request and wakeup projection are narrow helpers. Keep. |
| `execution/run-events.ts` | Cursor validation, exact sequence order, bounded page reads, and payload validation support PostgreSQL-authoritative SSE reconstruction. Keep. |
| `execution/execution-state.ts` | One stable optimistic-state conflict error. Keep. |
| `execution/artifacts.ts` | Pending/finalized artifact metadata, deterministic storage keys, capacity observation, and workspace scope are cohesive. The candidate loop is bounded and correctness-sensitive. Keep. |
| `execution/outbox.ts` | Canonical checksum helper and outbox insertion contract correctly bind transport payloads. Keep. |
| `execution/inbox.ts` | Exactly-once consumer receipt/replay semantics and checksum mismatch errors are deep and narrow. Keep. |
| `execution/dispatcher.ts` | Fair, leased `SKIP LOCKED` claims; publish/failure completion; Redispatch; and readiness are coherent. It owns a role-specific pool but should receive the process pool under DB-002. |
| `execution/dispatcher-rows.ts` | Row types/decoders support dispatcher mapping. Move shared types out of the composition root to remove its type-only cycle under DB-013. |
| `execution/deadline-wakeup-scanner.ts`, `due-node-wakeup-scanner.ts` | Very small adapters around bounded PostgreSQL due-work functions. They should share an injected worker pool instead of each allocating one. |
| `execution/published-workflow-reader.ts` | Strictly validates immutable published graph/executable/checksum/release projections for workers. Keep; its private pool is DB-002. |
| `execution/stored-execution-value.ts` | Iterative hostile-value scanner, canonical serializer, byte/member/depth bounds, and safe parser are justified infrastructure. Repeated cross-package JSON limits should be one persisted contract; DB-001/DB-014. |

### Coordinator run store

| File | Review |
| --- | --- |
| `execution/coordinator-run-store.ts` | Small public factory assembling load/ack/commit capabilities. This split materially improved navigation. Inject pool ownership under DB-002. |
| `coordinator-run-store-contract.ts` | Stable delivery/state/plan result types and repository errors. Good leaf contract; remaining child/root type cycles should converge here. |
| `coordinator-run-store-transactions.ts` | Common repeatable-read and tenant transaction wrappers correctly isolate coordinator snapshots. Apply process-wide timeout/deadline policy under DB-010. |
| `coordinator-run-store-delivery.ts` | Claim and acknowledgement enforce outbox checksum, run identity, lease, and replay invariants. Keep atomic flow. |
| `coordinator-run-store-observations.ts` | Reconstructs durable engine facts from run events, attempts, node state, failures, and cancellation with canonical bounds. The 64-row paging/casted joins and cross-package aggregate limit are DB-001/DB-005. |
| `coordinator-run-store-physical-state.ts` | Maps persisted checkpoint invocations to physical node/attempt identities and verifies consistency. Repeated collection scans are bounded but can use prepared maps under DB-009. |
| `coordinator-run-store-plan.ts` | Strict plan/checkpoint parse and invocation/loop consistency checks. Long functions express an atomic state-machine grammar; improve lookups rather than splitting by line count. |
| `coordinator-run-store-plan-validation.ts` | Admission, attempt, event, ordering, and capacity validation is cohesive. Keep. |
| `coordinator-run-store-status-validation.ts` | Validates allowed status transitions and event correspondence. Several repeated `find`/`some` traversals can share plan indexes under DB-009. |
| `coordinator-run-store-validation-values.ts` | Tiny common validation constants. Keep. |
| `coordinator-run-store-commit-state.ts` | Locks and validates current run/checkpoint/outbox state before commit. Long SQL-stage order is correctness-sensitive and intentionally retained by complexity controls. |
| `coordinator-run-store-run-transition.ts` | Derives run-level started/completed timestamps and terminal projection from plan events. Keep. |
| `coordinator-run-store-settlement.ts` | Validates loop barriers and invocation settlements. Keep. |
| `coordinator-run-store-terminal.ts` | Applies terminal result/output/error semantics. Keep. |
| `coordinator-run-store-execution.ts` | Persists failures, admissions, attempts, outbox work, physical identities, and events. Per-row round trips and nested searches scale poorly at the legal 300-node boundary; DB-009. |
| `coordinator-run-store-commit.ts` | Orchestrates lock, validation, execution persistence, checkpoint CAS, terminal state, and delivery acknowledgement. Cohesive despite length; do not split transaction order without a stronger phase abstraction. |

### Node-attempt and preview state machines

| File | Review |
| --- | --- |
| `execution/node-attempt-run-store.ts` | Small capability assembler over claim/input/delivery/heartbeat/completion/outcome modules. Good refactor; inject shared pool under DB-002. |
| `node-attempt-run-store-contract.ts` | Rich lease, inputs, completion, error, and dependency vocabulary. Move any remaining types imported from the root here to keep direction acyclic. |
| `node-attempt-run-store-transactions.ts` | Shared transaction helpers correctly scope worker operations. Apply DB-010 defaults. |
| `node-attempt-run-store-claim.ts` | Atomic inbox/attempt/run claim with lease fencing, deadline, side-effect and dispatch checks. Keep long operation cohesive. |
| `node-attempt-run-store-inputs.ts` | Loads pinned executable, checkpoint, run inputs, upstream outputs, loop/branch context, and connection requirements. The 264-line callback and repeated array searches need prepared indexes only when behavior-preserving tests demonstrate a clearer seam; DB-013/DB-009. |
| `node-attempt-run-store-dispatch.ts` | Fenced dispatch marking and stable mismatch mapping. Keep. |
| `node-attempt-run-store-delivery.ts` | Delivery acknowledgement preserves checksum and attempt identity. Keep. |
| `node-attempt-run-store-heartbeat.ts` | Lease heartbeat is narrow and maps stale claims intentionally. Keep. |
| `node-attempt-run-store-completion.ts` | Atomic completion of attempt/node plus coordinator wakeup; validates output and stale fences. Keep. |
| `node-attempt-run-store-outcomes.ts` | Maps executor outcomes to durable status/error/output semantics. Keep. |
| `execution/preview-execution.ts` | Stable facade over preview operations and error/status contracts. Keep. |
| `preview-execution-contract.ts` | Central preview delivery/lease/outcome schemas and errors. Good leaf contract. |
| `preview-execution-claim.ts` | Fenced preview claim with deadline, artifact, source-run, and immutable-executable validation. Keep. |
| `preview-execution-dispatch.ts` | Fenced dispatch transition and binding validation. Keep. |
| `preview-execution-delivery.ts` | Inbox acknowledgement and delivery identity checks. Keep. |
| `preview-execution-heartbeat.ts` | Narrow preview lease heartbeat. Keep. |
| `preview-execution-completion.ts` | Atomic terminal preview, output artifact, audit/usage, and event projection. Correctly cohesive. |
| `preview-execution-reconciliation.ts` | Reconciles possibly dispatched preview effects using durable evidence. Long but domain-coherent; private error translation remains explicit. |
| `execution/unknown-outcome-reconciliation.ts` | Generic node-attempt evidence reconciliation is fenced and idempotent. Keep. |
| `execution/testing.ts` | Purposeful test exports for state-machine seams; no production wildcard consumer was found. Keep. |

### Failure notification persistence

| File | Review |
| --- | --- |
| `execution/failure-notification-destinations.ts` | API-facing destination and policy aggregate. Validates encrypted config/version pins and lifecycle. Long factory and private pool are DB-013/DB-002, but the public capability is coherent. |
| `failure-notification-destination-store.ts` | Narrow SQL operations for destination/version/policy persistence. Keep. |
| `failure-notification-destination-errors.ts` | Stable destination-specific errors. Keep. |
| `failure-notifications.ts` | Worker claim/resolve/dispatch/heartbeat/completion facade. Correct authority boundary; private pool and redundant error listener are DB-002/DB-007. |
| `failure-notification-store-support.ts` | Shared schemas, row parsing, and transaction support. Move root-owned types here or to a contract leaf under DB-013. |
| `failure-notification-completion-store.ts` | Fenced retry/delivered/dead-letter/outcome-unknown completions are appropriately isolated. Keep. |
| `failure-notification-errors.ts` | Single stable worker state error. Keep. |

### Triggers and schedules

| File | Review |
| --- | --- |
| `triggers/workflow-trigger-projection.ts` | Pure graph-to-trigger projection with explicit supported kinds. Deep and easy to test. Keep. |
| `triggers/workflow-triggers.ts` | Reconciles desired publication state to provider/schedule health and activation. Transaction and stale-publication checks are strong; sequential desired-schedule handling is bounded but belongs in DB-009 performance evidence. |
| `triggers/webhook-triggers.ts` | Secret resolution, signature/replay/rate admission, durable acceptance, and idempotency are carefully separated. Private pool is DB-002; complexity is otherwise justified. |
| `triggers/schedule-recurrence.ts` | Pure cron/timezone/DST/misfire recurrence logic with explicit bounds. Keep. Minute iteration is bounded and tested. |
| `triggers/schedule-triggers.ts` | API schedule CRUD plus worker scanner, each with separate role pools and acceptance transaction. Correct authority split, but two private pools in the scanner amplify DB-002. |
| `triggers/schedule-trigger-errors.ts` | Small stable schedule error. Keep. |
| `triggers/testing.ts` | Exposes projection and scanner seams only for focused tests. Keep. |

### Lifecycle, retention, and control ledger

| File | Review |
| --- | --- |
| `lifecycle/control-ledger-coordinator.ts` | Deep reconciliation/inventory/repair module with hashes, monotonic sequence, command locks, bounded pages, cancellation, and recovery. Several external ledger calls occur while a database control lock is held; DB-003. Its long stages are intentional correctness complexity. |
| `lifecycle/workspace-lifecycle-commands.ts` | Receives privileged lifecycle intents, prepares/authorizes ledger append, projects state, and handles replay. External ledger operations inside the locked transaction and error-result behavior are DB-003/DB-007. |
| `lifecycle/retention.ts` | Dry-run, scheduling, lag observation, transient reap, operator rerun, and destructive enforcement are too many capabilities in one 812-line file. Split the two exported runtimes/contracts for locality; external reconciliation under lock and catch-all `released` outcomes are DB-003/DB-007/DB-013. |
| `lifecycle/preview-retention.ts` | Fenced preview artifact deletion/reconciliation is correct in intent but performs ledger and object-store operations with locks and idle transaction timeout disabled; DB-003. |
| `lifecycle/run-artifact-retention.ts` | Same durable deletion pattern for run artifacts and the same transaction/I/O concern; DB-003. |
| `lifecycle/workspace-purge.ts` | Bounded tenant-row/object pages, legal-hold behavior, ledger start/completion, leases and repair are extensive and well tested. Object-store and ledger calls inside open transactions make this the strongest DB-003 example. It already accepts a pool, demonstrating the desired resource seam. |
| `lifecycle/preview-cleanup.ts` | Lower-level database-only preview cleanup claims/completions are bounded and fenced. Keep. |
| `lifecycle/transient-data-retention.ts` | Tiny bounded function adapter for ephemeral cleanup. Keep. |
| `lifecycle/testing.ts` | Broad lifecycle test seam is appropriately isolated. Keep. |

### Operator and recovery

| File | Review |
| --- | --- |
| `operator/operator-commands.ts` | Public operator command API validates request fingerprints, dry-run, idempotency, and typed outcomes. Keep. |
| `operator/operator-command-runtime.ts` | One-connection privileged transaction runtime is appropriate for operator authority. No-op pool errors and general timeout policy are DB-007/DB-010. |
| `operator/operator-command-errors.ts` | Small stable execution error. Keep. |
| `operator/operator-run-replay.ts` | Worker-side replay request resolution verifies source run, pinned executable, new identity, lineage, admission, and acknowledgement. Keep. |
| `operator/testing.ts` | Focused test exports. Keep. |

### Package and local tooling files

| File | Review |
| --- | --- |
| `package.json` | Seven role-specific export subpaths prevent a broad production root from erasing authority boundaries. Dependencies are direct and current for the pinned lockfile; scripts clearly separate unit, selected coverage, and PostgreSQL integration execution. The missing combined coverage lane is DB-006, not an export-layout problem. |
| `raw-sql-table-registry.json` | All 19 function-owned/raw-SQL tables have an explicit owner, permitted roles, RLS classification, and rationale. This is useful ownership evidence; extending it from table-name coverage to migrated shape/grant/policy proof is DB-012. |
| `tsconfig.json` | Composite ESM declaration build is narrow to `src`, with test output excluded. Keep. |
| `tsconfig.test.json` | Typechecks source, every TypeScript test, and every Vitest configuration without emitting. Keep. |
| `vitest.config.ts` | Correctly routes non-integration tests and excludes build output. Keep. |
| `vitest.coverage.config.ts` | Deliberately enforces a strong ratchet only on the shared tenant transaction engine. Its comment is accurate; it must not be presented as package-wide coverage. DB-006 owns the missing combined unit/integration evidence. |
| `vitest.integration.config.ts` | Serial fork execution is appropriate for disposable-database migration, role, lock, and concurrency suites. The separate suffix/lane is purposeful test organization, not unnecessary directory structure. Keep. |

## SQL migration review

All 75 SQL files were included, not sampled. Their evolution is coherent and
forward-only in intent. Security-definer functions pin `search_path`, dynamic
role identifiers are safely quoted by the TypeScript renderer, operational
mutations are parameterized, and destructive retention work is page-bounded.
The principal issue is execution strategy: the runner wraps all files in one
transaction, so even migrations written for a future large installation cannot
use `CREATE INDEX CONCURRENTLY` or resumable commit points.

| Range | Files and responsibility | Assessment |
| --- | --- | --- |
| 0000-0005 | `rls_probe`, queue transport, artifacts, transport audit, execution acceptance, inbox least privilege | Establishes tenant/RLS and durable transport foundation with narrow grants. Strong. |
| 0006-0011 | execution vocabulary/runtime, identity/workspace, OIDC state/capacity, workspace creation idempotency | Clean staged foundation; OIDC purge is bounded by capacity. |
| 0012-0019 | authoring, published execution, value persistence, coordinator, invocation keys, compatibility releases/core-retention/preactivation | Correct immutable-version and execution transition model. Historical upgrades are well fixture-tested. |
| 0020-0029 | connections/usage, preview lifecycle/artifacts/cleanup/facts, provider idempotency | Strong secret indirection and preview isolation. Two historical UUIDv7 checks intentionally remain `NOT VALID`. |
| 0030-0036 | retry decisions, due wakeups, loops, waits, failure notification, Slack and Resend auth kinds | Durable waits/retries and side-effect policies align with ADRs. |
| 0037-0042 | failure destinations, fair execution admission, webhook/schedule triggers, hardening, admission lock | Feature-rich and constrained, but 0037/0038 contain broad historical data rewrites inside the global migration transaction; DB-004/DB-016. |
| 0043-0050 | run-input retention, control ledger, deletion projection/intents/hardening/side effects/API authority | Good separation of intent, append, projection, and privileged roles. Migration-time workspace-wide updates need production cardinality proof. |
| 0051-0060 | retention dry-run/enforcement/scheduling/classes, purge foundation/pages/completion | Runtime destructive work is page-bounded and resumable. The SQL design is stronger than the transaction scope used around external calls. |
| 0061-0068 | operator redispatch/ledger/recovery/trigger reconciliation/replay/maintenance rerun, published repair, artifact inventory | Strong auditable operator model. 0067 is necessary convergence debt after published migrations changed. |
| 0069-0074 | regional admission, preview deadline, OIDC browser binding, replica identity, transient retention, schedule-state RLS | Correct hardening and operational closure for the current head. |

Seven constraints intentionally remain unvalidated for historical compatibility:
the execution-entitlement FK, failure-destination-version FK, replay-lineage
check, two preview-terminal UUIDv7 checks, and two failure-intent pin/version
FKs. Readiness asserts several of these exact states, so this is not silent
drift. DB-016 requires a documented reconciliation or permanent-exception
lifecycle instead of leaving their future disposition implicit.

## Test and CI review

### What the suites prove

The test strategy is unusually strong for a persistence package. Unit tests
exercise parsers, config, recurrence, serialization, SQL contract fragments,
error mapping, and transaction cleanup. Integration tests create disposable
PostgreSQL databases, apply real migrations, connect with real runtime roles,
exercise RLS and grants, race concurrent claims/commits, and validate durable
facts after failures. Test directories are appropriate here: isolation by
package and the `.integration.test.ts` suffix let CI route service-backed tests
separately without putting test-only helpers into production bundles.

The 135 test-directory files were reviewed in these complete cohorts:

- **Authoring:** `workflow-authoring.test`, draft, atomicity, coordination,
  publication, readiness, and workflow-trigger projection suites prove
  revision CAS, idempotency, immutable versions, projections, rollback, and
  compatibility locks.
- **Compatibility:** compatibility release unit/integration, retained baseline
  fixture, persisted checkpoint, package contract, and published-migration
  repair suites prove rolling/retained releases, serialization, entrypoint
  boundaries, and forward convergence.
- **Connections:** connection tests, compatibility, lifecycle, concurrency/
  security, and integration-usage paths prove ciphertext indirection, version
  pinning, conflict mapping, RLS, grants, and concurrent transitions.
- **Identity and tenancy:** identity/workspace, OIDC binding/capacity,
  workspace transaction engine, tenant-context hygiene, RLS, lifecycle API
  authority, and workspace creation suites prove fail-closed scope cleanup,
  identity uniqueness, token secrecy, and role isolation.
- **Execution and transport:** execution acceptance (capacity, lifecycle,
  notification, persistence, regional, security), coordinator CAS/commit/
  loops/migrations/attempts/observations/failures/scheduling/wakeups, node
  attempt, run events, preview worker lifecycle/reconciliation/schema,
  artifact, inbox/outbox transport, stored value, published reader, unknown
  outcome, waits/wakeups, and workflow-run API suites cover the primary state
  machines and failure modes.
- **Triggers:** webhook migration/prior-head/runtime, schedule migration/runtime,
  recurrence, and projection suites prove signature replay, rate admission,
  DST/misfire recurrence, leasing, and publication reconciliation.
- **Lifecycle:** control ledger, retention control/inventory/legal hold/
  scheduling/enforcement/artifacts/operator, preview retention, run-input and
  standard classes/dry runs, transient reap, deletion side effects, lifecycle
  intents/hardening, and workspace purge foundation/tenant/object/completion
  suites prove bounded destructive flows, leases, legal holds, and repair.
- **Operator/recovery:** command ledger, outbox redispatch, execution recovery,
  trigger reconciliation, replay, maintenance rerun, regional admission/
  replica, and restore inventory suites prove audited privileged commands and
  recovery handoff.
- **Platform/migrations:** config, persisted ID, telemetry, readiness/serving,
  checksum compatibility, and every named migration contract test prove UUIDv7,
  instrumentation, schema head, roles/grants/RLS, clean-head, and supported
  prior-head evolution.

The three top-level fixture files (`baseline-compatibility-fixture`, coordinator
and execution-acceptance fixtures) and eight files under `test/support` are
shared setup/data builders, not phantom tests. The nine
`src/**/testing.ts`/testing entry modules are deliberate internal seams. There
are 123 files ending in `.test.ts`, 63 of which are real-service integration
files; the remaining 12 test-directory files are 11 TypeScript fixtures/support
modules plus the queue duplicate-proof SQL fixture.

### What the suites do not yet prove

- There is no combined unit-plus-integration source coverage report. The
  enforced high threshold is one security-critical file only.
- There is no representative-cardinality `EXPLAIN (ANALYZE, BUFFERS)` or load
  regression gate for hot queries, nor production `pg_stat_statements` evidence.
- CI proves zero-to-head and selected retained-head migrations, not the lock/
  WAL/duration impact of applying all historical DML to a large installation.
- Local tests cannot prove managed backup/PITR configuration, restore drills,
  deployed pooler limits, autovacuum behavior, failover, or replica lag.
- Cross-package tests do not currently reach the database's legal 10,000-fact
  output and then parse that state in the engine; DB-001 escaped both suites.

CI organization is sound: static quality, unit groups, selected coverage, and
service-backed integration/recovery jobs are separate and run on pinned Node,
pnpm, and action versions. The prior pull-request run was green, and this audit
commit starts a fresh run. A green CI result means the encoded contracts passed;
it does not invalidate uncovered capacity, resource-budget, online-migration,
or production-operations findings.

### Reviewed SQL and test file manifest

This manifest makes the complete file scope reproducible. Responsibilities and
assurance conclusions are grouped above; every file below was included in that
review.

**SQL migrations (75):**

- `0000_rls_probe.sql`
- `0001_queue_transport.sql`
- `0002_artifacts.sql`
- `0003_transport_security_audit.sql`
- `0004_execution_acceptance.sql`
- `0005_inbox_least_privilege.sql`
- `0006_execution_vocabulary.sql`
- `0007_execution_runtime.sql`
- `0008_identity_workspace.sql`
- `0009_oidc_login_transactions.sql`
- `0010_oidc_transaction_capacity.sql`
- `0011_workspace_creation_idempotency.sql`
- `0012_workflow_authoring.sql`
- `0013_published_workflow_execution.sql`
- `0014_execution_value_persistence.sql`
- `0015_coordinator_run_store.sql`
- `0016_engine_invocation_keys.sql`
- `0017_node_compatibility_releases.sql`
- `0018_phase3_core_executor_non_removal.sql`
- `0019_node_compatibility_preactivation.sql`
- `0020_connections.sql`
- `0021_workflow_integration_usage.sql`
- `0022_preview_execution.sql`
- `0023_preview_artifact_ownership.sql`
- `0024_preview_retention_cleanup.sql`
- `0025_preview_cleanup_idempotency.sql`
- `0026_preview_cleanup_terminal_guard.sql`
- `0027_preview_terminal_facts.sql`
- `0028_preview_terminal_fact_corrections.sql`
- `0029_provider_idempotency_key_invariants.sql`
- `0030_coordinator_retry_decisions.sql`
- `0031_due_node_wakeups.sql`
- `0032_for_each_barriers.sql`
- `0033_durable_wait.sql`
- `0034_run_failure_notifications.sql`
- `0035_slack_bot_token_connections.sql`
- `0036_resend_api_key_connections.sql`
- `0037_failure_notification_destinations.sql`
- `0038_execution_admission.sql`
- `0039_webhook_triggers.sql`
- `0040_schedule_triggers.sql`
- `0041_trigger_hardening.sql`
- `0042_worker_run_admission_lock.sql`
- `0043_workflow_run_input_retention.sql`
- `0044_retention_control_foundation.sql`
- `0045_control_ledger_command_lock.sql`
- `0046_workspace_deletion_control_projection.sql`
- `0047_workspace_lifecycle_command_intents.sql`
- `0048_workspace_lifecycle_command_hardening.sql`
- `0049_workspace_deletion_side_effects.sql`
- `0050_workspace_lifecycle_api_authority.sql`
- `0051_workflow_run_input_retention_dry_run.sql`
- `0052_workflow_run_input_retention_enforcement.sql`
- `0053_preview_retention_enforcement.sql`
- `0054_workflow_run_input_retention_scheduling.sql`
- `0055_standard_retention_classes.sql`
- `0056_workspace_purge_foundation.sql`
- `0057_workspace_tenant_rows_purge.sql`
- `0058_workspace_object_versions_purge.sql`
- `0059_workspace_purge_completion.sql`
- `0060_standard_retention_dry_run.sql`
- `0061_operator_outbox_redispatch.sql`
- `0062_operator_command_ledger.sql`
- `0063_operator_execution_recovery.sql`
- `0064_operator_trigger_reconciliation.sql`
- `0065_operator_run_replay.sql`
- `0066_operator_maintenance_rerun.sql`
- `0067_reconcile_published_migration_repairs.sql`
- `0068_restore_artifact_inventory.sql`
- `0069_regional_write_admission.sql`
- `0070_preview_execution_deadline.sql`
- `0071_oidc_browser_binding.sql`
- `0072_regional_replica_identity.sql`
- `0073_transient_data_retention.sql`
- `0074_retention_schedule_state_rls.sql`

**Test and fixture/support files (135):**

- `artifacts.integration.test.ts`
- `baseline-compatibility-fixture.ts`
- `compatibility-release.integration.test.ts`
- `compatibility-release.test.ts`
- `config.test.ts`
- `connection-tests.integration.test.ts`
- `connections-compatibility.integration.test.ts`
- `connections-concurrency-security.integration.test.ts`
- `connections-lifecycle.integration.test.ts`
- `control-ledger-command-lock-migration.test.ts`
- `control-ledger-coordinator-part-2.integration.test.ts`
- `control-ledger-coordinator.integration.test.ts`
- `control-ledger-coordinator.test.ts`
- `coordinator-retry-migration.test.ts`
- `coordinator-run-store-cas.integration.test.ts`
- `coordinator-run-store-commit-output.integration.test.ts`
- `coordinator-run-store-foreach.integration.test.ts`
- `coordinator-run-store-migrations.integration.test.ts`
- `coordinator-run-store-node-attempts.integration.test.ts`
- `coordinator-run-store-observations.integration.test.ts`
- `coordinator-run-store-pending-failures.integration.test.ts`
- `coordinator-run-store-scheduling.integration.test.ts`
- `coordinator-run-store-wakeups.integration.test.ts`
- `coordinator-run-store.fixtures.ts`
- `coordinator-run-store.test.ts`
- `due-node-wakeup-migration.test.ts`
- `durable-wait-migration.test.ts`
- `execution-acceptance-capacity.integration.test.ts`
- `execution-acceptance-lifecycle.integration.test.ts`
- `execution-acceptance-notifications.integration.test.ts`
- `execution-acceptance-persistence.integration.test.ts`
- `execution-acceptance-regional.integration.test.ts`
- `execution-acceptance-security.integration.test.ts`
- `execution-acceptance.fixtures.ts`
- `execution-acceptance.test.ts`
- `execution-admission-migration.test.ts`
- `execution-value-persistence.integration.test.ts`
- `execution-value-persistence.test.ts`
- `for-each-barrier-migration.test.ts`
- `identity-workspace.integration.test.ts`
- `migration-checksum-compatibility.test.ts`
- `node-attempt-run-store.test.ts`
- `oidc-browser-binding-migration.integration.test.ts`
- `oidc-browser-binding-migration.test.ts`
- `operator-command-ledger-migration.test.ts`
- `operator-execution-recovery-migration.test.ts`
- `operator-maintenance-rerun-migration.test.ts`
- `operator-outbox-redispatch-migration.test.ts`
- `operator-run-replay-migration.test.ts`
- `operator-trigger-reconciliation-migration.test.ts`
- `package-contract.test.ts`
- `persisted-id.test.ts`
- `persisted-workflow-checkpoint.test.ts`
- `postgres-telemetry.integration.test.ts`
- `postgres-telemetry.test.ts`
- `preview-execution-deadline-migration.integration.test.ts`
- `preview-execution-deadline-migration.test.ts`
- `preview-execution.integration.test.ts`
- `preview-retention-enforcement-migration.test.ts`
- `preview-retention-migration.integration.test.ts`
- `preview-worker-artifact-retention.integration.test.ts`
- `preview-worker-attempt-lifecycle.integration.test.ts`
- `preview-worker-reconciliation.integration.test.ts`
- `preview-worker-schema.integration.test.ts`
- `published-migration-repair.integration.test.ts`
- `published-migration-repair.test.ts`
- `published-workflow-reader.integration.test.ts`
- `published-workflow-reader.test.ts`
- `readiness-probe.test.ts`
- `regional-replica-identity-migration.test.ts`
- `regional-write-admission-migration.test.ts`
- `regional-write-admission.integration.test.ts`
- `restore-artifact-inventory-migration.test.ts`
- `retention-artifacts.integration.test.ts`
- `retention-control-foundation-migration.integration.test.ts`
- `retention-control-foundation-migration.test.ts`
- `retention-execution-purge.integration.test.ts`
- `retention-inventory.integration.test.ts`
- `retention-legal-hold.integration.test.ts`
- `retention-operator.integration.test.ts`
- `retention-schedule-state-rls-migration.test.ts`
- `retention-scheduling.integration.test.ts`
- `rls.integration.test.ts`
- `run-events.integration.test.ts`
- `schedule-recurrence.test.ts`
- `schedule-trigger-migration.test.ts`
- `schedule-triggers-part-2.integration.test.ts`
- `schedule-triggers.integration.test.ts`
- `serving-readiness.test.ts`
- `standard-retention-classes-migration.test.ts`
- `standard-retention-dry-run-migration.test.ts`
- `stored-execution-value.test.ts`
- `tenant-context-hygiene.integration.test.ts`
- `transient-data-retention-migration.test.ts`
- `transient-data-retention.integration.test.ts`
- `transport-part-2.integration.test.ts`
- `transport.integration.test.ts`
- `transport.test.ts`
- `webhook-trigger-migration.test.ts`
- `webhook-trigger-prior-head.integration.test.ts`
- `webhook-triggers.integration.test.ts`
- `workflow-authoring-atomicity.integration.test.ts`
- `workflow-authoring-coordination.integration.test.ts`
- `workflow-authoring-drafts.integration.test.ts`
- `workflow-authoring-publication.integration.test.ts`
- `workflow-authoring-readiness.integration.test.ts`
- `workflow-authoring.test.ts`
- `workflow-run-api.integration.test.ts`
- `workflow-run-input-retention-dry-run-migration.test.ts`
- `workflow-run-input-retention-enforcement-migration.test.ts`
- `workflow-run-input-retention-migration.integration.test.ts`
- `workflow-run-input-retention-migration.test.ts`
- `workflow-run-input-retention-scheduling-migration.test.ts`
- `workflow-trigger-projection.test.ts`
- `workspace-deletion-control-projection-migration.test.ts`
- `workspace-deletion-side-effects-migration.test.ts`
- `workspace-lifecycle-api-authority-migration.test.ts`
- `workspace-lifecycle-command-hardening-migration.test.ts`
- `workspace-lifecycle-command-intents-migration.test.ts`
- `workspace-lifecycle-command-intents.integration.test.ts`
- `workspace-object-versions-purge-migration.test.ts`
- `workspace-purge-completion-migration.test.ts`
- `workspace-purge-foundation-migration.test.ts`
- `workspace-purge-foundation.integration.test.ts`
- `workspace-tenant-rows-purge-migration.test.ts`
- `workspace-transaction-engine.test.ts`
- `support/connections.integration.support.ts`
- `support/control-ledger-coordinator.integration.support.ts`
- `support/disposable-database.ts`
- `support/preview-worker-fixture.ts`
- `support/retention.integration.support.ts`
- `support/schedule-triggers.integration.support.ts`
- `support/transport.integration.support.ts`
- `support/workflow-authoring.integration.support.ts`
- `fixtures/queue-duplicate-proof.sql`


## Findings and required improvements

### DB-001 — Persisted observation capacity disagrees with the engine

- **Severity/classification:** P1 confirmed defect.
- **Status:** open; also recorded as WFE-001.
- **Evidence:** `coordinator-run-store-observations.ts` accepts 10,000 facts and
  up to 4,096 canonical bytes per fact, for a 40,960,000-byte aggregate. The
  engine first normalizes the complete observation array through a generic
  10,000-member/one-MiB JSON boundary. A direct probe with 6,000 valid-shaped
  `node.progress` facts serialized to 1,186,897 bytes and was rejected as
  `observation_invalid`; roughly 1,500 seven-field facts already exceed the
  engine member limit.
- **Impact:** PostgreSQL can persist and reload a state that the engine cannot
  advance. A valid long-lived/noisy run can become permanently unrecoverable
  even though both packages pass independently.
- **Required change:** define one shared persisted-observation envelope and
  capacity vocabulary. Either make the engine admit the full database maximum
  with a separately bounded parser, or page/stream summarized facts so the
  engine never receives the full history. Do not merely lower one constant
  without considering retained runs already above it.
- **Verification:** an end-to-end database-to-engine test at exact maximum
  count/bytes, one-over rejection tests at the owning boundary, and retained-run
  migration/recovery behavior.

### DB-002 — Repository factories multiply the process connection budget

- **Severity/classification:** P1 architecture and production-capacity defect.
- **Status:** open.
- **Evidence:** at least 27 production factory sites call
  `createDatabasePool`; most do not accept a supplied pool. API composition
  constructs independent workspace, identity, OIDC, authoring, run, connection,
  failure-destination, webhook, and schedule repositories. With the API default
  `DATABASE_POOL_MAX=5`, ten such factories represent approximately 50 normal
  backend slots per replica before monitor connections. Worker and maintenance
  composition create additional independent pools. The configured maximum is
  therefore per repository, not per process.
- **Impact:** replica scaling can exhaust PostgreSQL connections, cause queueing
  in many invisible local budgets, and make pool saturation metrics misleading.
  The plan explicitly requires aggregate pooling and headroom before adding
  replicas.
- **Required change:** create one pool/runtime owner per process and database
  role, inject it into repositories, and make factory ownership explicit
  (`pool`, `ownsPool`). Add a process-level connection budget including lock
  monitor, migration, maintenance, operator, autoscaling replicas, failover
  headroom, and any external pooler. Repositories must not end injected pools.
- **Verification:** composition test counts actual `pg_stat_activity` sessions
  at startup/peak/close; deployment validation rejects an aggregate above the
  database budget; shutdown proves every owned pool and monitor closes once.

### DB-003 — External I/O is awaited while database locks are held

- **Severity/classification:** P1 architecture/reliability risk.
- **Status:** open.
- **Evidence:** preview retention, run-artifact retention, destructive
  retention, lifecycle commands, control-ledger recovery, and workspace purge
  begin transactions, set lock/statement timeouts, set
  `idle_in_transaction_session_timeout` to zero, lock control state, and then
  await ledger reconciliation/append or object-store delete/head/purge calls.
  External calls have an application AbortSignal, normally 30 seconds, but the
  database connection and row/advisory locks remain occupied throughout.
- **Impact:** object-store or ledger latency becomes database lock latency.
  Repeated stalls can exhaust the fragmented pools, block vacuum progress,
  increase deadlock/timeout pressure, and make a process interruption leave
  external effects whose database transaction rolled back.
- **Required change:** model prepare/perform/complete as a durable leased and
  fenced workflow. Commit the prepared intent and anchor first, perform network
  I/O outside the transaction, then complete in a short transaction that
  rechecks fence/high-water state. Reconciliation must safely adopt already-
  performed effects. If any path cannot be changed, document measured lock
  duration and use a finite idle-in-transaction timeout above the bounded
  external envelope instead of disabling the backstop.
- **Verification:** delayed/unavailable ledger and object-store tests with
  concurrent tenant operations, connection saturation, process kill after the
  external effect, stale-fence takeover, and lock-duration assertions.

### DB-004 — The migration runner cannot deliver the documented online strategy

- **Severity/classification:** P1 plan-compliance and production-readiness gap.
- **Status:** open before a large production dataset exists.
- **Evidence:** `migrateDatabase` begins one transaction before reading all
  pending files and commits after all have run. All 102 indexes use ordinary
  `CREATE INDEX`; `CREATE INDEX CONCURRENTLY` cannot run in that transaction.
  Historical migrations such as 0037 and 0038 perform broad updates/inserts/
  grouping over existing tenant/run data in the same release transaction. The
  plan requires expand/migrate/switch/contract, bounded resumable backfills,
  progress metrics, and nonblocking large-index strategies where appropriate.
- **Impact:** an upgrade on a mature installation can hold locks, retain a very
  large transaction/WAL volume, block vacuum, exceed deployment timeouts, and
  roll back all pending work after a late failure.
- **Required change:** support declared migration modes: short transactional
  DDL, online nontransactional operations, and separate resumable data jobs.
  Preserve checksum/order history and the advisory release lock while allowing
  per-step durable completion. Add lock/statement timeouts, preflight size
  checks, progress/observability, and explicit rollback compatibility. Do not
  retroactively edit published SQL.
- **Verification:** upgrade a representative large seeded previous-head
  database under concurrent reads/writes; capture lock time, WAL, duration,
  retry/resume after interruption, and query availability.

### DB-005 — Fact loading uses many round trips and non-index-friendly joins

- **Severity/classification:** P2 performance/scale improvement.
- **Status:** fixed in the repository on 2026-09-05; production-cardinality
  monitoring remains part of DB-011.
- **Evidence:** `readPersistedFacts` reads at most 64 rows per query, so the
  accepted 10,000 rows require up to 157 queries inside one repeatable-read
  transaction. Joins compare `attempt.id::text` and `node.id::text` to JSON
  strings, placing casts on indexed UUID columns. This combines transaction
  age, repeated parsing, and potentially poor join plans.
- **Required change:** persist relational attempt/node IDs where facts require
  them or cast already validated payload values to UUID on the value side;
  choose a measured page size or server-side streaming strategy; and avoid
  keeping more history than the engine requires.
- **Verification:** `EXPLAIN (ANALYZE, BUFFERS)` with representative tenant/run
  cardinality and 1/1,500/10,000 facts, plus round-trip and transaction-duration
  benchmarks. Confirm malformed legacy payloads still fail closed.
- **Implemented:** event rows are fetched in bounded 1,000-row pages and their
  canonical payloads/UUID identities are validated in application memory.
  Unique validated attempt IDs are then resolved in one relational
  `uuid[]` lookup scoped by workspace and workflow run. This removes JSON joins,
  prevents malformed legacy values from reaching a PostgreSQL UUID cast, and
  reduces the maximum legal window from 157 event fetches to ten plus one
  physical-state lookup. The 40 MiB canonical observation-window bound remains
  unchanged.
- **Repository evidence:**
  `coordinator-run-store-observations.integration.test.ts` exercises public
  loading at 1, 1,500, and 10,000 facts, runs
  `EXPLAIN (ANALYZE, BUFFERS)` for both relational queries, and verifies index
  scans remain available with sequential scans disabled. On the disposable
  PostgreSQL fixture used on 2026-09-05, the three end-to-end cases completed in
  27 ms, 97 ms, and 373 ms respectively. The same suite proves malformed legacy
  identities fail with `CoordinatorRunStateCorruptError`, not a database cast
  error. Command: `pnpm --filter @pertexo/database exec vitest run
  test/coordinator-run-store-observations.integration.test.ts --config
  vitest.integration.config.ts --reporter=verbose` (16/16).

### DB-006 — Coverage reporting does not describe the whole package

- **Severity/classification:** P2 assurance improvement.
- **Status:** open; existing tests remain valuable.
- **Evidence:** CI enforces 95.38% branch coverage only for
  `tenant-access/workspace.ts`. Instrumenting all source while running unit tests
  produced 14.71% branches and 23.08% statements because most persistence logic
  is exercised only in uninstrumented PostgreSQL integration tests. The
  repository risk report likewise governs a selected cohort rather than every
  database branch.
- **Required change:** merge V8 coverage from unit and integration shards, or
  maintain an auditable source-to-risk/test manifest where instrumentation is
  impractical. Ratchet high-risk execution, migration, lifecycle, identity,
  trigger, and recovery modules rather than imposing an arbitrary global
  percentage. Record justified unreachable/defensive branches explicitly.
- **Verification:** CI publishes one package report identifying source covered
  by unit tests, integration tests, reviewed exceptions, and genuinely
  unreviewed branches; new critical branches must lower or update the ratchet.

### DB-007 — Infrastructure and coordinator failures lose diagnostics

- **Severity/classification:** P2 reliability/observability improvement.
- **Status:** open.
- **Evidence:** `createDatabasePool` and several callers install no-op idle-pool
  error listeners; lock-monitor sampling resets state and silently catches all
  failures. Destructive retention catches every error, attempts rollback and
  release, then returns `released` without preserving an error class. Similar
  lifecycle result paths intentionally convert operational errors to retryable
  states but provide no diagnostic callback here.
- **Impact:** processes avoid crashing, but operators cannot distinguish a
  transient claim race from PostgreSQL connection loss, corrupt returned state,
  ledger inconsistency, or repeated external timeout. Retry loops may look
  healthy while making no progress.
- **Required change:** keep mandatory pool listeners but emit bounded structured
  events/counters through an injected diagnostic port. Record operation,
  database role, safe error class/code, and retry/release outcome; never SQL,
  DSNs, payloads, or secrets. Only expected stale/claim races should become
  quiet state results; invariant corruption should surface distinctly.
- **Verification:** forced idle-client error, monitor permission/network error,
  ledger mismatch, corrupt row, and rollback/release failure tests assert both
  caller semantics and sanitized telemetry.

### DB-008 — Publication work grows with all retained versions and triggers

- **Severity/classification:** P2 query/performance improvement.
- **Status:** open.
- **Evidence:** publication selects and decodes every version for a workflow,
  then finds a checksum in JavaScript despite a unique
  `(workflow_id, checksum)` identity. It separately searches the rows again.
  Trigger projections are then upserted sequentially in a loop, while
  integration usage in the same function already demonstrates a batched
  `jsonb_to_recordset` approach.
- **Required change:** select an existing version directly by workspace,
  workflow, and checksum; obtain next version under the existing workflow lock
  only on insert. Batch trigger projection upserts while preserving exact kind,
  workspace, workflow, and version conflict guards.
- **Verification:** publish with thousands of retained versions and the maximum
  legal triggers; prove idempotent reuse, atomic rollback, stable version
  numbering, and bounded query count.

### DB-009 — Legal maximum transition plans cause per-row SQL and repeated scans

- **Severity/classification:** P2 performance/maintainability improvement.
- **Status:** open.
- **Evidence:** coordinator commit loops over failures, node admissions,
  attempts, and events, issuing sequential statements; several loops perform
  `find`/`some` over the same plan arrays. Publication and trigger
  reconciliation contain similar bounded row-at-a-time writes. The graph limit
  makes this finite (roughly 300 nodes), but not cheap.
- **Required change:** build plan indexes once by invocation/event identity and
  use set-based inserts/updates where database constraints can retain the same
  fail-closed semantics. Keep ordered event sequences and row-count/invariant
  checks; a faster but weaker bulk write is not acceptable.
- **Verification:** exact-max graph commit benchmark, query-count assertion,
  concurrency/CAS regression suite, and deliberate missing/conflicting rows to
  prove bulk operations remain atomic and corruption-sensitive.

### DB-010 — Normal transactions lack an enforceable deadline policy

- **Severity/classification:** P2 reliability improvement.
- **Status:** open.
- **Evidence:** pool configuration sets connection and idle-pool timeouts, but
  most repositories have no default PostgreSQL `statement_timeout`,
  `lock_timeout`, or `idle_in_transaction_session_timeout`. The shared tenant
  helper supports an optional statement timeout, yet many call sites omit it.
  AbortSignals are optional and are not consistently propagated from every
  API/repository operation.
- **Required change:** define role/workload-specific transaction defaults and a
  request/job deadline budget. Apply finite statement, lock, and idle-in-
  transaction limits on connection/transaction setup; pass cancellation to all
  queries; add connection lifetime/query timeout if the driver/runtime supports
  it. Long maintenance operations should use bounded pages, not infinite
  statements.
- **Verification:** blocked-lock, slow-statement, abandoned-callback, request
  cancellation, and shutdown tests prove bounded termination, rollback, client
  destruction when necessary, and no scope leakage on reuse.

### DB-011 — Hot query and index design lacks representative workload proof

- **Severity/classification:** P2 unverified performance assumption.
- **Status:** open and explicitly dependent on workload evidence.
- **Evidence:** functional integration tests run mostly on small disposable
  datasets. No checked plan/baseline exists for outbox claims, schedule/wakeup
  scans, coordinator fact loading, run/event pagination, retention/purge, or
  connection impact queries. The migrated catalog has no exact duplicate
  indexes, but write-heavy `workflow_runs` has 12 indexes and `node_runs` has
  seven. The plan correctly defers partitioning until measurements justify it.
- **Required change:** add a deterministic representative data generator and
  record query plans/latency/query count for hot paths. In staging/production,
  collect `pg_stat_statements`, table/index size and usage, lock waits, dead
  tuples, autovacuum progress, and cache behavior. Define thresholds for BRIN/
  B-tree changes, partial indexes, and partitioning of append-heavy facts. Do
  not remove indexes based only on count.
- **Verification:** repeatable load report at expected and burst cardinality,
  with planner/index evidence and regression budgets tied to stated SLOs.

### DB-012 — Schema ownership is checked more deeply for names than shapes

- **Severity/classification:** P2 assurance/maintainability improvement.
- **Status:** open.
- **Evidence:** the schema validator extracts migration table names, Drizzle
  table names, registry entries, UUID defaults, and forced-RLS declarations.
  It does not compare columns, types, nullability, defaults, keys, checks,
  indexes, delete behavior, grants, or policies between the typed model,
  registry expectations, and migrated catalog. Nineteen application tables are
  raw-SQL registered because functions own their behavior.
- **Required change:** make the registry a schema contract, not only an
  ownership list. Generate or query a disposable migrated catalog and compare
  expected columns/constraints/indexes/RLS/grants. Type raw tables in Drizzle
  only where application query composition benefits; do not duplicate SQL
  functions mechanically.
- **Verification:** mutation tests remove/change a column, FK, check, index,
  RLS policy, and grant from both typed and raw categories and prove CI fails.

### DB-013 — Contract ownership and large factory locality can be clearer

- **Severity/classification:** P2 maintainability improvement.
- **Status:** open; no runtime circular dependency exists.
- **Evidence:** authoring, coordinator, dispatcher, failure notification,
  operator, and identity child modules import types from composition roots that
  also import those children. `connection-persistence.ts` exports roughly 63
  internal symbols. `retention.ts` owns two runtimes plus unrelated maintenance
  concerns. Several large factory functions are object literals containing
  many independently meaningful methods.
- **Required change:** extract stable leaf-neutral contract/codecs modules;
  split retention dry-run/administration from destructive enforcement; split
  connection authorization, row codecs, and transaction vocabulary along real
  capability seams. Extract named method builders only where they reduce
  knowledge required to change one behavior. Preserve atomic state-machine
  stages and avoid one-helper-per-file churn.
- **Verification:** runtime and type import graphs are acyclic, public `.d.ts`
  snapshots remain compatible, package tests stay green, and the deletion test
  shows each retained abstraction hides nontrivial policy.

### DB-014 — Validation/configuration vocabulary is repeated

- **Severity/classification:** P3 readability/reuse improvement.
- **Status:** open.
- **Evidence:** four role environment schemas repeat PostgreSQL URL,
  connection/idle timeout, owner/worker role, and pool-limit definitions. UUID,
  digest, timestamp, bounded text, and JSON validation helpers recur across
  authoring, execution, connections, identity, triggers, and lifecycle.
- **Required change:** create small schema factories for database connection and
  role fields while preserving distinct environment variable names, defaults,
  and error paths. Centralize only persisted boundary primitives that truly have
  one contract; retain domain-specific limits locally.
- **Verification:** existing config/parser snapshots and exact boundary tests
  remain unchanged; deleting the helper would require duplicating real policy,
  satisfying the abstraction deletion test.

### DB-015 — Pool telemetry role and monitor identity are configuration-sensitive

- **Severity/classification:** P3 observability improvement.
- **Status:** open.
- **Evidence:** pool role is inferred from hard-coded default usernames, while
  configuration permits custom role names; custom deployments report `other`.
  Lock monitors are shared by connection identity but the key omits sample
  interval, so the first pool silently chooses cadence for later pools using the
  same connection identity. Saturation reports the maximum per pool, not total
  checked-out share against the process/database budget.
- **Required change:** pass an explicit bounded role at pool creation, define
  monitor cadence conflict behavior, and add aggregate configured capacity and
  active/waiting counts by role/process. Keep DSNs and usernames out of emitted
  labels.
- **Verification:** custom-role, same-DSN/different-interval, multiple-pool,
  acquire/release/end, and metric-cardinality tests.

### DB-016 — Historical migration exceptions need an explicit retirement ledger

- **Severity/classification:** P3 continuous-control/compatibility debt.
- **Status:** open as lifecycle documentation, not a request to rewrite history.
- **Evidence:** the runner accepts historical published checksums for migrations
  0037, 0038, and 0070; migration 0067 reconciles affected states. Seven
  constraints intentionally remain unvalidated for historical rows, and
  readiness pins several exact `NOT VALID` definitions. Current upgrade tests
  prove supported states can reach head.
- **Required change:** record each accepted checksum and unvalidated constraint
  with affected release/database populations, forward repair, invariant for new
  rows, detection query, owner, and retirement/permanent-exception criterion.
  Preserve immutable copies of all published migration bytes. Never fold a new
  correction into an already released file.
- **Verification:** inventory every deployed schema checksum/constraint state;
  remove compatibility exceptions only after no supported database needs them
  and a restore/upgrade rehearsal proves the retirement path.

### DB-017 — Backup, restore, pooler, vacuum, and failover claims require deployed evidence

- **Severity/classification:** P2 unverified production assumption.
- **Status:** open outside local code.
- **Evidence:** the plan requires managed PostgreSQL backups/PITR, restore
  drills, connection pooling, RPO/RTO, multi-AZ behavior, and operational
  monitoring. Disposable CI databases prove application recovery semantics but
  cannot prove cloud configuration, restore duration, WAL retention, pooler
  transaction compatibility with `SET LOCAL`, autovacuum capacity, or replica
  identity/lag under failover.
- **Required change:** retain infrastructure evidence for backup schedules,
  PITR window, encrypted snapshots, restore drills, failover tests, connection
  headroom, pooler mode, parameter settings, vacuum/transaction-age alarms, and
  replica admission behavior. Link evidence from the implementation progress/
  external-platform contract; do not mark it complete from repository tests.
- **Verification:** staged restore and failover drills with recorded RPO/RTO,
  tenant/RLS smoke tests through the deployed pooler, and workload dashboards
  showing connection, transaction, lock, vacuum, disk/WAL, and replica health.

## Prioritized remediation sequence

1. Resolve DB-001 first because it is a current cross-package correctness
   failure with a reproducible legal input.
2. Establish one process/role pool owner and a real deployment connection
   budget (DB-002), then add transaction deadline/error telemetry
   (DB-007/DB-010/DB-015). These controls make later performance work measurable.
3. Redesign network-under-lock lifecycle paths as durable prepare/perform/
   complete state machines (DB-003) before production retention/purge volume.
4. Add transactional/online/resumable migration modes and large-upgrade proof
   (DB-004/DB-016). Do this before schema/data size makes the conversion risky.
5. Add combined risk coverage and representative query/load evidence
   (DB-006/DB-011), then optimize facts, publication, and transition batches
   from measured plans (DB-005/DB-008/DB-009).
6. Deepen schema-contract validation and improve internal contract locality
   (DB-012/DB-013/DB-014) without destabilizing the proven state machines.
7. Close DB-017 only with deployed infrastructure and restore/failover evidence.

## Definition of completion

This audit is complete for the pinned tree; the implementation is not “fully
fixed” until each finding above has evidence and an explicit closed or accepted
status. Completion requires more than green unit tests:

- the shared database/engine capacity contract passes exact-boundary tests;
- process connection totals fit the deployment budget with headroom;
- no unapproved external network wait occurs under a database transaction lock;
- large migrations and backfills are online, interruptible, and resumable;
- combined test evidence maps all critical persistence paths to coverage or a
  reviewed exception;
- hot queries have representative planner/load evidence;
- schema shape, grants, RLS, and migration exceptions have machine-checked
  ownership; and
- backup, PITR, restore, failover, pooler, and vacuum assumptions have current
  deployed proof.

No class/function/file should be split solely because it is long. Refactor when
the new seam reduces the knowledge required to make a safe change, removes
repeated policy, permits shared resource ownership, or makes an invariant
directly testable. That standard preserves the package's strongest property:
correctness rules remain visible at the transaction and state-machine boundary.
