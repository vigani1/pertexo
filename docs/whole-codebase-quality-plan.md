# Whole-codebase quality review and implementation plan

Date: 2026-09-12. Status: **review and plan complete; implementation not authorized**.
Reviewer: primary agent. This expands beyond the eight-item structural review.

## Start here

All **1,587 frozen files** have individual ledger judgments. The review produced
**232 WQ finding records**, organized into **42 ordered work packages**, alongside
the eight existing structural items. These are not 232 confirmed runtime bugs:
the records distinguish FIX, REFACTOR, TEST, CONDITIONAL and KEEP decisions.

- [Implementation order](whole-codebase-review/implementation-order.md): primary
  ownership, prerequisites, exact acceptance by work package, code-shape examples
  and cross-package integration. Start here to plan implementation.
- [Finding index](whole-codebase-review/finding-index.md): every WQ identifier
  linked to its detailed source/test locations and evidence.
- [Scope reconciliation](whole-codebase-review/reconciliation.md): file counts,
  source stability, historical/data distinctions and preservation checks.
- The area ledgers below supply every file's judgment, including justified
  retained code and localized test/readability work, not only headline findings.

The earliest correctness work includes credential redaction before Nest
truncation; truthful cancellation of running For Each bodies; preview dispatch
authority; SQL NULL/UUIDv7 boundary repairs; tenant-purge dependencies; and
external-ledger freshness before destructive retention. The detailed records
distinguish reproduced local behavior, source-evidenced defects and still-needed
real-database interleavings. Fixture/Git isolation precedes destructive tests or
mutation execution; trustworthy measurement precedes optional optimization.

## Scope and evidence rules

Review the current dirty checkout, not only committed files or previously
flagged modules. The initial inventory contains 1,587 existing first-party
files: application/package source, tests and support, migrations, build/CI and
infrastructure, contracts/fixtures, and documentation. Ignored dependencies,
compiled output, coverage output, local secrets and runtime data are excluded
from authoring review; their generating source and relevant export contracts
are included. Generated fixture/report data is checked as data against its
schema/producer, not called hand-written application logic. Published SQL and
historical audits are reviewed for current implications but never rewritten to
make history look cleaner.

Every file receives a ledger entry. A file is not reviewed merely because it
was enumerated, hashed, linted, assigned a complexity score or mentioned by an
earlier audit. Code judgments require reading the implementation; related test
evidence is distinguished from runtime proof. A retained file gets a concrete
reason, not an automatic PASS. Unchecked items stay PENDING until checked.

The prior [structural plan](structural-follow-up-plan.md) remains the detailed
owner of PF-01–PF-07 and WF-S01. This plan links those findings rather than
inventing duplicates; newly discovered findings use `WQ-` identifiers.

## Judgment rubric

Apply relevant criteria to every file. `N/A` is permitted with the file's role,
not as an escape from inspecting it. No arbitrary overall score hides a
correctness defect behind good formatting.

| ID | Criterion | Questions and evidence required |
| --- | --- | --- |
| J01 | Correctness and domain truth | Are state transitions, invariants, precedence, identity, replay/idempotency and terminal behavior correct? Check callers, persistence and negative cases. |
| J02 | Readable control flow | Can a reader explain the happy path and each exceptional branch? Identify nested ternaries, mixed boolean operators, inverted conditions, repeated discrimination, fall-through and unrelated cases interleaved in one function. Name predicates only when the name adds domain meaning. |
| J03 | Conditions and state representation | Are independent flags admitting impossible combinations? Is a discriminated union, exhaustive switch, decision table or ordered phase clearer? Preserve evaluation order, short-circuit side effects and distinct null/undefined/false meanings. Do not replace a readable guard with abstraction. |
| J04 | Naming and explanation | Do names express intent, units, ownership and domain meaning? Are abbreviations/local temporaries understandable? Comments should explain why or a non-obvious invariant, not paraphrase code or claim unproved guarantees. |
| J05 | Cohesion and module depth | Does the interface hide meaningful work? Is knowledge duplicated across callers? Would merging concentrate complexity or merely move it? Are private helpers useful concepts or fragmentation? Keep cohesive validators/state machines even when large. |
| J06 | Type and validation discipline | Validate unknown input at the correct seam; avoid unchecked casts, non-null assertions, impossible variants and duplicated runtime/type schemas. Preserve ordinary TypeScript and existing Zod/contracts rather than adding new frameworks. |
| J07 | Async/resource ownership | Who acquires, starts, transfers, aborts and closes every resource? Verify partial startup, sync throws, promise rejection, cleanup ordering, listener/timer removal, in-flight drain and bounded shutdown. An abort request is not proof underlying work stopped. |
| J08 | Errors and observability | Are original causes and stable public error contracts preserved? Can logging itself alter correctness? Check swallowed errors, ambiguous successes, sensitive metadata, cardinality and actionable diagnostics. |
| J09 | Security and authority | Validate authorization, tenant identity/RLS, SQL parameterization, provider/network policy, secret lifetime, output minimization, replay protection and fail-closed behavior. No speculative exploit claims without a reachable path. |
| J10 | Concurrency and persistence | Inspect transaction scope, lock/fence ownership, isolation, stale work, duplicate delivery, retry boundaries, deterministic ordering and migrations. Never hold a transaction across unbounded external I/O. |
| J11 | Bounded work and performance | Check input/queue/cache/page/time bounds, repeated scans/copies and allocation. Distinguish structural avoidable work from measured latency problems. Index/cache proposals require lifetime, invalidation and behavior-preservation evidence. |
| J12 | Tests and change safety | Do assertions prove public behavior, failure paths and invariants? Check fixture validity, mock fidelity, ordering dependence, real-clock sleeps, cleanup, duplicated setup, assertion blindness and coverage claims. Test-only logic is reviewed too. |
| J13 | Dependencies and build/export contracts | Check actual imports/exports, DI ownership, cycles, browser/server isolation, configuration duplication, version pins and executable CI gates. Existing compiler/runtime architecture stays intact. |
| J14 | Documentation and operational consistency | Separate historical records from live instructions; verify links, commands, authority requirements, head/version claims, owners and acceptance evidence. Do not manufacture deployed qualification. |

### How a judgment becomes work

- **FIX**: evidenced correctness, safety or operational defect; identify
  triggering inputs/state and the observable consequence.
- **REFACTOR**: concrete reading/change burden with a demonstrably clearer
  equivalent; show current code/location and proposed shape, invariants and
  tests. "Too long" alone is not enough.
- **TEST**: specific behavioral evidence missing or misleading; name the seam,
  scenario and assertions. A missing test is not automatically a bug.
- **CONDITIONAL**: plausible improvement requiring a benchmark, contract or
  compatibility decision; record a pass/fail gate and KEEP fallback.
- **KEEP**: inspected, coherent code for its responsibility; state why its
  conditions, length, duplication or seam are justified.
- **DATA/GENERATED**: inspect schema, producing mechanism, consistency and
  representative semantics; never pretend rows were individually interpreted
  as source logic.

Priority is consequence-driven: P1 incorrect durable/security behavior or
resource-loss risk; P2 meaningful maintainability/operability/test weakness;
P3 localized polish or conditional optimization. Cosmetic preferences do not
justify risky rewrites. Each actionable record must contain exact files and
line/symbol locations, observed code/problem, proposed change, preserved
contracts, test changes, dependencies, acceptance and implementation order.

### External guidance and project-specific limits

The rubric uses official guidance where behavior matters: TypeScript
[narrowing and exhaustiveness](https://www.typescriptlang.org/docs/handbook/2/narrowing.html),
Node [stream lifecycle/backpressure](https://nodejs.org/docs/latest-v24.x/api/stream.html),
PostgreSQL 18 [concurrency](https://www.postgresql.org/docs/18/mvcc.html), and
Nest [shared modules](https://docs.nestjs.com/modules#shared-modules). These
support mechanisms, not a universal maximum number of conditions or lines.

Project contracts and ADRs outrank generic style advice. Do not introduce native
TypeScript stripping, a replacement test runner, new error/logging/lifecycle
frameworks, an ORM, a new provider, or speculative caching. Do not delete
boundary tests merely because a helper is merged. Do not treat unverifiable
claims such as a fixed percentage improvement in "testability" as evidence.

## Review progress

- [x] Establish scope and explicit judgment rubric.
- [x] Freeze inventory and bind each record to current file contents.
- [x] Read and judge all application/package code.
- [x] Review all tests/support and contract fixtures.
- [x] Review all migrations and database behavior contracts.
- [x] Review infrastructure, CI/build/configuration and live documentation.
- [x] Reconcile every inventory file with a final ledger disposition.
- [x] Consolidate verified findings into ordered implementation units with
      code examples and exact regression acceptance.
- [x] Validate source stability, paths, references and documentation; report
      remaining runtime/external evidence honestly.

No source fixes, migrations, commits, pushes, provider calls or deployments are
authorized by this review request. Existing dirty work is preserved.

### Completed area ledgers

- [Historical records and generated evidence](whole-codebase-review/documentation-records.md):
  45 files; documentary scope/status review plus full-row JSON/TSV consistency.
  Earlier completion labels are not substituted for current source review.

- [Live documentation and blueprint](whole-codebase-review/documentation-live.md):
  26 files; WQ-232 and precise documentation follow-ups linked to source
  findings. Historical qualification and external authority remain distinct.

- [Architecture decisions](whole-codebase-review/documentation-adrs.md): all
  35 ADRs, preserving accepted contracts and identifying dated/superseded
  deployment descriptions without rewriting decision history.

- [Root, build and CI](whole-codebase-review/root-and-ci.md): 26 files;
  WQ-231. Lockfile/importer consistency checked; missing ordinary PR gates
  distinguished from weekly/manual release and local checks.

- [Benchmark tooling](whole-codebase-review/infrastructure-performance.md): eight
  files; WQ-228–WQ-230. Fifty tests passed, with synthetic probes for delayed
  rejection, partial cleanup and invalid accepted measurement evidence.

- [Coverage evidence infrastructure](whole-codebase-review/infrastructure-coverage-evidence.md):
  seven files; WQ-226–WQ-227 and shared WQ-216. Thirty tests passed; literal
  semantics fingerprint collision and empty-counter behavior reproduced.

- [Quality orchestration](whole-codebase-review/infrastructure-quality-runner.md):
  five files; WQ-223–WQ-225. Mutation Git isolation and qualification evidence
  require targeted hardening; mutation execution was deliberately not run.

- [Infrastructure operations](whole-codebase-review/infrastructure-operations.md):
  20 files; WQ-220–WQ-222. Eight pure exercise tests and offline structural
  checks passed; no live load or telemetry qualification claimed.

- [Infrastructure deployment](whole-codebase-review/infrastructure-deployment.md):
  22 files; WQ-217–WQ-219. Read-only synthetic validation separates declared
  contracts from actual AWS/container qualification.

- [Infrastructure quality gates](whole-codebase-review/infrastructure-gates.md):
  36 files; WQ-212–WQ-216. Sixty-six tests passed; three pure gate-boundary
  probes reproduced missing validation or incorrect link resolution.

- [Final migrations](whole-codebase-review/database-migrations-final.md): five
  files, 0082–0086; completes SQL inventory and checks effective replacements.

- [Operator and later migrations](whole-codebase-review/database-migrations-operations.md):
  21 SQL files, 0061–0081; WQ-211 and shared SQL-boundary findings.
  Includes concrete tenant-purge pointer/FK conflicts; database execution pending.

- [Execution migrations](whole-codebase-review/database-migrations-execution.md):
  23 SQL files, 0017–0039; WQ-206–WQ-208. Source-level UUIDv7 mismatch
  confirmed; current database execution remains a required regression step.
- [Retention/lifecycle migrations](whole-codebase-review/database-migrations-retention.md):
  21 SQL files, 0040–0060; WQ-209–WQ-210 plus shared migration findings.
  Preserves published history and separates external deletion ownership.

- [Database foundation migrations](whole-codebase-review/database-migrations-foundation.md):
  17 SQL files, 0000–0016; WQ-204–WQ-205. Historical upgrade/lock-time tests are
  conditional follow-ups; published migration bytes remain unchanged.

- [Database static migration tests](whole-codebase-review/database-static-migration-tests.md):
  29 files; WQ-203. All 31 tests passed; source-text checks remain distinct from
  executed SQL and effective privilege evidence.

- [Database retention integration](whole-codebase-review/database-retention-integration.md):
  five files; WQ-202 and shared findings. Reviewed capacity, references, holds,
  replay lineage, staged deletion and exact historical migration tests.

- [Database workspace lifecycle](whole-codebase-review/database-workspace-lifecycle.md):
  seven files; WQ-198–WQ-199 and shared safety findings. Three cancellation tests
  passed; both integration suites inspected without service execution.

- [Database cross-cutting tests](whole-codebase-review/database-crosscutting-tests.md):
  13 files; WQ-200–WQ-201. Twenty-eight unit tests passed; reviewed cancellation,
  regional fencing, persisted values, inventory and scheduling evidence.

- [Database retention orchestration](whole-codebase-review/database-retention.md):
  eight files; WQ-193–WQ-194/WQ-197. Source-only interleaving reached artifact
  deletion after external ledger advance; all remaining retention suites have
  now been inspected in the separate integration ledgers, not service-executed.

- [Database control ledger](whole-codebase-review/database-control-ledger.md):
  eight files; WQ-195–WQ-196 and WQ-193. Twenty unit tests passed; a source probe
  reproduced clean connection release after an undefined rollback rejection.

- [Database node attempts](whole-codebase-review/database-node-attempts.md):
  12 files; WQ-186–WQ-187. Full claim, input, dispatch and completion paths plus
  the integration suite inspected; real-service execution remains separate.

- [Database previews](whole-codebase-review/database-preview.md): 19 files;
  WQ-188–WQ-192. Three static tests passed. Source-only probes reproduced output
  validation drift, changed-output duplicate acceptance and double JSON encoding.

- [Database coordinator](whole-codebase-review/database-coordinator.md):
  33 files; WQ-181–WQ-185. Both read-only artifact-lock paths reached in injected
  source probes; post-commit metric stall demonstrated. Three static tests passed;
  integration suites were read, not run.

- [Database notifications](whole-codebase-review/database-notifications.md):
  9 files; WQ-178–WQ-180. Twelve completion tests passed; source-only injected
  client probes confirmed missing numeric boundary validation. Audit target
  mismatch identified directly in source; no service-backed test was run.

- [Rate-limit](whole-codebase-review/rate-limit.md): 12 files; WQ-001.
- [Node SDK](whole-codebase-review/node-sdk.md): 18 files; WQ-002–WQ-005;
  41 existing tests passed and three current-source defects reproduced locally.
- [Node catalog](whole-codebase-review/node-catalog.md): 17 files; WQ-006–WQ-007;
  20 existing tests passed.
- [Core nodes](whole-codebase-review/nodes-core.md): 69 files; WQ-008–WQ-009;
  96 existing tests passed and direct For Each schema stack overflow reproduced.
- [Workflow model](whole-codebase-review/workflow-model.md): 39 files;
  WQ-010–WQ-013 and existing PF-07; package build and 97 tests passed.

- [Queue](whole-codebase-review/queue.md): 31 files; WQ-014–WQ-017;
  61 existing tests passed; controlled readiness and telemetry probes reproduced.

- [Observability](whole-codebase-review/observability.md): 28 files;
  WQ-018–WQ-021 and existing PF-03; 71 tests passed; synthetic log-prefix
  disclosure, normalization throw and post-limit getter reads reproduced.

- [Artifact store](whole-codebase-review/artifact-store.md): 40 files;
  WQ-022–WQ-027; 287 unit tests passed; cancellation, classification, normalized
  replay and PUT verification gaps reproduced with local fixtures.

- [Integrations](whole-codebase-review/integrations.md): 52 files;
  WQ-028–WQ-036; 293 unit tests passed; malformed refusal/status, historical
  uncertainty, hostile rejection, redirect context, late-response ownership,
  crypto temporary-buffer and URL-validation probes completed locally.

- [Workflow engine](whole-codebase-review/workflow-engine.md): 87 files;
  WQ-037–WQ-045 and existing PF-05/PF-06/WF-S01; 346 unit tests passed.
  Public-operation probes reproduced timestamp, input-admission and error
  handling gaps; the real database status validator rejected the engine's
  premature running-loop-body cancellation plan.

- [Operational applications](whole-codebase-review/operational-apps.md): 46 files;
  WQ-046–WQ-050 and existing PF-01–PF-03; 109 tests passed across recovery,
  operator, lifecycle and retention. Lifecycle compiled build/process tests
  passed; deferred-operation probes exposed a retention child-drain gap and
  undefined-rejection discrimination failure.

- [Public contracts](whole-codebase-review/contracts.md): 60 files, including
  18 generated documents checked against their producers; WQ-051–WQ-054.
  All 50 tests and artifact/OpenAPI checks passed; Unicode URL, deeply nested
  input and webhook replay-schema discrepancies reproduced locally.

- [API platform and bootstrap](whole-codebase-review/api-platform.md): 55 files;
  WQ-055–WQ-060 and existing PF-02/PF-03. API build and all 672 unit tests
  passed; real Nest shutdown, error normalization, rate-limit diagnostics and
  in-flight readiness probes reproduced gaps. Redis integration tests were
  inspected but not executed against a service.

- [API artifacts and catalog](whole-codebase-review/api-artifacts-catalog.md):
  21 files; WQ-061–WQ-063. All code, unit tests and transfer-fixture code were
  read; API typecheck passed. A local finalization probe confirmed that a
  post-verification authorization denial is incorrectly mapped to an outage,
  while correctly preventing finalization. Service-backed transfer remains
  separately gated, not executed by this audit.

- [API connections](whole-codebase-review/api-connections.md): 23 files;
  WQ-064–WQ-067. All 66 connection tests passed. Local public-interface probes
  reproduced trace-induced repeated work and skipped resource cleanup; no
  external provider or database call ran.

- [API identity and workspaces](whole-codebase-review/api-identity-workspaces.md):
  55 files; WQ-068–WQ-074 and extensions of WQ-064/WQ-065. All 187 unit tests
  passed. Local probes reproduced inconsistent authorization-proof reuse and
  callback schema drift; OAuth guidance rules out strict unknown-parameter
  rejection as the fix. Real-service integration was inspected, not executed.

- [API schedules and webhooks](whole-codebase-review/api-schedules-webhooks.md):
  21 files; WQ-075–WQ-078 and runtime cleanup extensions to WQ-065. All 34 unit
  tests passed. Real Fastify probes confirmed trace failures prevent otherwise
  valid acceptance; the integration/database-deletion paths were only read.

- [API node testing](whole-codebase-review/api-node-testing.md): 14 files;
  WQ-079–WQ-081. All 22 unit tests passed. Actual use-case probes reproduced
  false-valid config-version reporting and blocked exact replay after a draft
  edit, without making provider or database calls.

- [API workflow authoring](whole-codebase-review/api-workflow-authoring.md):
  29 files; WQ-082–WQ-084 and a WQ-064 telemetry extension. All 60 unit tests
  passed. Publication's replay ordering is retained; full-tag save authority is
  explicitly conditional on ADR-011's documented model, not called a proven bug.

- [API executions, workflow runs and workflow runtime](whole-codebase-review/api-executions-workflow-runs.md):
  32 files; WQ-085–WQ-090 and a WQ-065 runtime extension. API build and all 83
  targeted unit tests passed. Local probes confirmed iterator rejection hangs,
  near-expiry refresh churn, skipped cleanup and metric-induced stream closure;
  destructive Redis and database integration fixtures were inspected only.

- [Worker platform and lifecycle](whole-codebase-review/worker-platform.md):
  34 files; WQ-091–WQ-095 and WQ-057/PF-02/PF-03 integration. Worker build and
  52 selected unit tests passed. Injected probes confirmed dropped cancellation
  options, logging-dependent safety actions, stalled readiness revocation and
  acceptance of an overflowing timer interval; no process/service signal ran.

- [Worker transport and outbox](whole-codebase-review/worker-transport.md):
  18 files; WQ-096–WQ-099 and WQ-085/WQ-057 extensions. All 33 targeted tests
  passed. Local probes exposed early repeated-close success, post-close dispatch,
  unnecessary shutdown delay, skipped sibling close and accumulating timed-out
  capacity work. Durable unknown-publication lease behavior is retained.

- [Worker telemetry](whole-codebase-review/worker-telemetry.md): 12 files;
  WQ-100–WQ-101 and WQ-064 integration. Nine targeted tests passed. Local
  probes confirmed span-end outcome replacement, repeated HTTP work and
  classifier-induced rejection replacement. Existing coordinator/trigger
  recording containment is retained.

- [Worker coordinator, triggers and compatibility](whole-codebase-review/worker-coordinator-triggers.md):
  19 files; WQ-102–WQ-103. Eight safe unit files / 25 tests passed. Fully
  injected probes reproduced skipped close, stalled trigger shutdown,
  post-close readiness and logger-terminated scanning. Coordinator runtime
  tests with incompletely injected service adapters were inspected only.

- [Worker maintenance and failure notifications](whole-codebase-review/worker-maintenance-notifications.md):
  ten files; WQ-104–WQ-105 and WQ-102/WQ-028/WQ-030 integration. All 53
  targeted tests passed. Local probes distinguished abort from settlement and
  showed a retry fixture passing without reaching its second provider call.

- [Worker production node execution and capabilities](whole-codebase-review/worker-node-execution.md):
  16 files; WQ-106–WQ-110. Worker build, 41 engine/handler tests and three
  selected ownership tests passed. Fully injected probes reproduced residual
  heartbeats, concurrent dispatch permission, unclosed upload stream, uncleared
  overflow chunk and work continuing past cancellation.

- [Worker preview execution](whole-codebase-review/worker-preview-execution.md):
  five files; WQ-111–WQ-113 and WQ-079/WQ-107 integration. All 39 tests
  passed. Local probes confirmed dropped dispatch authority fields, post-stop
  heartbeat invocation, unowned late invocation and unsupported config-version
  execution through the real registry. PostgreSQL checkout was blocked.

- [Worker transport integration and service control](whole-codebase-review/worker-transport-integration.md):
  six files; WQ-114–WQ-116. Both safe controller tests passed; an injected
  clock probe confirmed a restart command after recovery-budget expiry.
  Service-loss and database/Redis suites were inspected, not executed.

- [Worker coordinator integration and fixtures](whole-codebase-review/worker-coordinator-integration.md):
  15 files; WQ-117–WQ-119. Fully inspected retained execution, replay,
  branching/iteration recovery, identity fencing, retry/wait and notification
  evidence. Verified the same-ID redelivery gap against producer configuration
  and BullMQ's official contract; no destructive integration suite ran.

- [Worker preview integration and crash evidence](whole-codebase-review/worker-preview-integration.md):
  nine files; WQ-120–WQ-122. Fully read delivery, retention, SIGKILL,
  crash-boundary and Validate scenarios. An injected actual-source probe
  reproduced retained timers, malformed-output listener failure and stale
  evidence waiters; no child/service/provider was started.

- [Worker lifecycle, trigger and artifact integration](whole-codebase-review/worker-lifecycle-artifact-integration.md):
  four files; WQ-123–WQ-124. Reviewed real artifact and workflow convergence
  proofs, skipped-suite acquisition, shared-queue interference and assertion
  scope. No SQL, Redis or object-store integration action was executed.

- [Worker schedule integration and benchmark fixture](whole-codebase-review/worker-schedule-integration.md):
  one file; WQ-125–WQ-126 and WQ-123 integration. Fully inspected schedule
  publication, contention, fairness, recovery and drain evidence. An injected
  runtime probe confirmed the benchmark-gate shutdown cycle; no benchmark ran.

- [Worker HTTP/provider integration](whole-codebase-review/worker-http-integration.md):
  three files; WQ-127–WQ-128. Completed all worker file judgments, preserving
  genuine redelivery/fencing evidence and identifying fixture ownership,
  artifact cleanup, scenario coupling and replay-claim gaps. No services ran.

- [Database foundation](whole-codebase-review/database-foundation.md): 17 files;
  WQ-129–WQ-131 and PF-02 extension. All 52 selected unit tests passed;
  unsafe diagnostic classification and double-release of a shared lock sampler
  were reproduced with no database service. Integration proofs were inspected.

- [Database readiness](whole-codebase-review/database-readiness.md): 13 files;
  WQ-132–WQ-134. All seven selected unit tests passed. Read the complete
  composed startup SQL and supporting operational instructions; identified
  incomplete drift predicates and unsafe shared-schema test ownership without
  applying any drift or running database services.

- [Database migration runner](whole-codebase-review/database-migration-runner.md):
  12 files; WQ-135–WQ-137. Nine selected unit tests passed; acquisition-error
  masking reproduced locally. Current execution plan and 66-entry retained
  history suffix verified. All numbered SQL bodies are now reviewed in the
  separate migration ledgers.

- [Database schemas and package surfaces](whole-codebase-review/database-schema-surfaces.md):
  30 files; WQ-138–WQ-139. Static ownership check and its test passed; a source
  probe confirmed the all-typed-table schema test omits artifact_links. No
  database calls ran.

- [Database tenant access](whole-codebase-review/database-tenant-access.md):
  16 files; WQ-140–WQ-143. Four unit tests passed. Disconnected driver and source
  probes reproduced ignored session cancellation, invalid expiry admission and
  recursive metadata failure; live identity/OIDC integration was not run.

- [Database connections](whole-codebase-review/database-connections.md):
  14 files; WQ-144–WQ-146. All source and four integration suites plus fixture
  code read; preserves atomic rotation/replay guarantees and records explicit
  dispatch-order qualification and fixture-ownership work. No service test ran.

- [Database workflow authoring](whole-codebase-review/database-authoring.md):
  22 files; WQ-147–WQ-149. Six unit tests passed; fully inspected publication,
  lifecycle/restoration, lock races and rollback evidence. Retained-history
  optimization is conditional on preserving corruption detection. No service ran.

- [Database compatibility and checkpoint codecs](whole-codebase-review/database-compatibility.md):
  ten files; WQ-150–WQ-153. Eight unit tests passed. Injected probes confirmed
  missing rollback-disposal signaling and diagnostic cause loss; a source-only
  codec comparison demonstrated a Merge-validation discrepancy requiring
  downstream admission qualification. Integration suites were not executed.

- [Database workflow triggers and webhooks](whole-codebase-review/database-workflow-webhook-triggers.md):
  14 files; WQ-154–WQ-158. Six selected unit tests passed; an intercepted-source
  probe reproduced pool/monitor ownership loss on invalid construction. Reviewed
  lifecycle and replay proofs without running service-backed integration.

- [Database schedules](whole-codebase-review/database-schedules.md): 14 files;
  WQ-159–WQ-162 and WQ-157 extension. All 26 selected unit tests passed.
  Intercepted probes confirmed pre-abort work and recurrence-error cleanup gaps;
  inspected concurrency/upgrade evidence and measured local recurrence cost.

- [Database execution values and readers](whole-codebase-review/database-execution-values-readers.md):
  five files; WQ-163 and WQ-134/WQ-157 extensions. Safe iterative value handling
  is retained; reader/classifier assertions and isolated drift fixtures need
  stronger evidence. Integration code was read, not executed.

- [Database run admission and events](whole-codebase-review/database-run-admission-events.md):
  18 files; WQ-164–WQ-167 and WQ-157 extension. Two vocabulary tests passed;
  source-only probes reproduced error replacement and mixed event metadata.
  Fully inspected atomicity, capacity, replay, security and lock-race suites.

- [Database transport and duplicate-proof fixtures](whole-codebase-review/database-transport.md):
  12 files; WQ-168–WQ-170 and readiness/rollback extensions. Five unit tests
  passed. Reviewed durable fairness, token fencing, inbox atomicity and lost-ACK
  controls; identified pre-bound JSON recursion and post-COMMIT decoding order.

- [Database operator commands and worker reconciliation](whole-codebase-review/database-operator.md):
  17 files; WQ-171–WQ-173 and constructor/rollback extensions. Fourteen selected
  tests passed; intercepted probes confirmed cancellation and repeated-close
  behavior. Preserved the distinction between committed conflict audit and
  post-commit public rejection.

- [Database artifacts and lifecycle locking](whole-codebase-review/database-artifacts.md):
  15 files; WQ-174–WQ-177. Twenty selected tests passed. Source-only probes
  reproduced a client-disposal gap and finalization after observed cancellation;
  retained required post-verification authorization and metadata revalidation.

All 1,587 frozen files now have judgments. The
[scope reconciliation](whole-codebase-review/reconciliation.md) records exact
counts, supporting-table duplicates, unchanged source hashes and the distinction
between manual source review and historical/data review. The ordered plan assigns
every WQ finding once, with no missing or duplicate primary ownership, and
integrates all eight structural items without duplicating their detailed plans.

## Final review verification and limits

Reconciliation checked all 16 inventories: 1,587 unique paths, 1,587 matching
file dispositions, zero extra first-column paths and zero changed/missing frozen
source hashes. The seven supporting-table duplicates are explained rather than
double-counted. All 232 unique WQ headings have one primary work-package owner;
all 42 packages have detailed acceptance sections. The only 93 new files since
the freeze are this plan and its review directory.

`pnpm docs:check` passed its 13 tests and local documentation-link validation.
The Prettier check command over this plan, ledger Markdown and inventory JSON
also passed for matched files. Area ledgers separately record executed package
tests and bounded synthetic probes; their counts are not summed into a misleading
unique whole-repository test total.

No full service-backed qualification, destructive SQL/Redis/object-store suite,
live provider exercise, performance qualification, mutation campaign or AWS
deployment was run for this review. No claim of a clean bill of health follows
from passing existing tests: several local probes reproduced defects despite
those tests passing. Required regression and external evidence remain planned,
not silently waived.

Git handoff: `main` at `778a406256e5f70ed724f36a72018095ff828c51`, 27 ahead and
zero behind the locally recorded `origin/main`; no fetch/remote-freshness claim.
No source fixes, migration changes, commits or pushes were made for this review.
The pre-existing dirty worktree is preserved; the new review documents are
uncommitted. Implementation requires a subsequent user request.
