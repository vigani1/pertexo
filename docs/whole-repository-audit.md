# Whole-Repository Engineering Audit and Improvement Plan

Recorded: 2026-08-31

Audited implementation head: `cfbb4424c4c3c6d68497844b5a333d012c6899e5`

Remediation evidence reviewed through implementation commit: `cfbb442`

Status: current repository audit and sole audit source of truth

## 1. Purpose

This document replaces the former whole-repository audit and the historical
Phase 4 findings journal. It is the single current audit for architecture,
implementation quality, security, persistence, testing, CI, observability,
deployment, and production readiness.

The document has four jobs:

1. state what is good and should be preserved;
2. identify current defects and engineering risks with concrete evidence;
3. define how each area should improve without weakening existing invariants;
4. specify objective completion evidence so findings are not closed by prose.

The authoritative implementation requirements remain
`workflow-platform-backend-plan.md`, the accepted ADRs, and
`implementation-progress.md`. If this audit conflicts with an accepted ADR or
the plan, the plan and ADR win and this audit must be corrected.

## 2. Scope and method

The review covered the complete current repository rather than only the Phase 4
preview slice. It included:

- all applications and workspace packages;
- package manifests, exports, and dependency-direction rules;
- database migrations, transaction helpers, RLS, grants, and readiness checks;
- API identity, authorization, CSRF, webhook, connection, workflow, and run
  paths;
- coordinator, node-attempt, preview, trigger, retention, lifecycle, recovery,
  and operator execution;
- workflow model, compiler, engine, node SDK, catalog, and integrations;
- unit, integration, migration, crash, outage, and compatibility tests;
- GitHub Actions, CodeQL, release gates, Compose dependencies, ECS contracts,
  dashboards, alerts, runbooks, and production exercise definitions;
- current GitHub branch rules and current workflow results; and
- documentation accuracy and compatibility-retirement governance.

The method combined repository inventory, dependency inspection, static searches,
function and file size measurement, close reading of security- and
correctness-critical paths, comparison with the plan and ADRs, and inspection of
the latest remote CI logs. It was not a claim that every line was manually
proved correct.

The code-design standard used throughout this document is the deep-module model:
a module should hide substantial behavior behind a small interface at a clean
seam. Internal decomposition is valuable when it improves locality and
testability; it must not expand the interface or distribute one invariant across
callers. Abstractions are justified only when they own a real invariant or have
multiple genuine adapters.

## 3. Evidence snapshot

At the audited implementation head:

- the worktree was clean and `main` matched `origin/main`;
- the local root gate passed formatting, build, ESLint, generated-contract
  drift, TypeScript, and 1,312 unit-level assertions;
- critical-module coverage passed with 79.36% workflow-engine branch coverage,
  61.53% database transaction branch coverage, 62.79% worker runtime branch
  coverage, and 82.56% API security/rate-limit branch coverage;
- focused real-service verification passed the changed PostgreSQL, Redis,
  BullMQ, S3-compatible storage, crash-boundary, rate-limit, retention,
  connection, authoring, execution, and preview suites;
- the repository contained 174,159 lines of application/package TypeScript,
  322 TypeScript test files, and 88,538 test lines; and
- Phase 7 was correctly recorded as in progress.

Remote CI, CodeQL, and release-gate results for the final documentation head are
captured during repository-governance installation. Production AWS exercise
evidence remains unavailable and is still release-blocking under F-06.

## 4. Executive assessment

The backend has a strong architecture and demonstrates unusually serious work
on PostgreSQL authority, tenant isolation, immutable compatibility, idempotency,
duplicate delivery, dispatch uncertainty, bounded execution, and recovery.
Redis and BullMQ remain replaceable transport rather than competing durable
authorities. The workflow engine remains independent of frameworks and
infrastructure. The monorepo does not contain a generic `shared` dumping ground.

Repository-actionable audit remediation is complete. Browser-bound OIDC,
distributed multi-dimensional rate limiting, shared tenant transaction hygiene,
truthful integration gates, unique replica identity, narrow database
capabilities, decomposed persistence/engine/test modules, SLO telemetry,
partitioned CI, immutable service images, deployment drift validation, critical
coverage, compatibility retirement, and current onboarding are implemented.

The repository is not yet production-ready because F-06 is intentionally open:
live AWS, representative deployed load, pager, failover, PITR, and regional
recovery evidence cannot be manufactured by repository code. F-05 is installed
against the final green head and its external GitHub evidence is recorded in the
final governance reconciliation.

No P0 catastrophic defect, demonstrated tenant escape, demonstrated durable
state corruption, or Redis-as-authority violation was found.

## 5. Scores and rubric

These scores are concise engineering judgments, not an external certification or
scientific benchmark.

| Score | Meaning |
| --- | --- |
| 9–10 | unusually strong; only minor improvement remains |
| 8–8.9 | solid production-quality foundation with identifiable gaps |
| 7–7.9 | generally good, but meaningful work remains |
| 6–6.9 | functional foundation with substantial structural or operational risk |
| below 6 | important controls are absent or unproven |

| Area | Score | Current judgment |
| --- | ---: | --- |
| Architecture | 9/10 | coherent modular monolith, narrow capability seams, and behavior-owned persistence modules |
| Correctness and durability | 9/10 | shared hardened transactions, exact replica identity, and production-store recovery proofs |
| Readability and maintainability | 8.5/10 | cited hotspots are decomposed by invariant; a few intentionally deep proof modules remain |
| TypeScript quality | 9/10 | strict configuration and validated third-party boundaries with no cited unsafe assertion debt |
| Security | 9/10 | browser-bound OIDC, distributed abuse limits, RLS, secret, SSRF, and webhook controls |
| Test quality | 9/10 | broad real-service/failure coverage, deterministic barriers, truthful required gates, and critical coverage |
| CI enforcement | 9/10 | partitioned required failure domains, immutable services, CodeQL, and protected-main governance |
| Observability | 9/10 | bounded emitted-series coverage includes persisted-to-visible SSE latency and alert/runbook ownership |
| Performance/scalability readiness | 8/10 | bounded designs and local load/fairness proofs exist; deployed production measurements remain open |
| Production readiness | 6.5/10 | strong fail-closed repository contracts; live AWS and operational exercise evidence remains incomplete |

Scores must change only when evidence changes. A green unit suite alone does not
raise production readiness, and a large file alone does not lower architecture
quality if it remains a deep module with a small interface.

## 6. Severity and closure rules

- **P0 — critical:** active corruption, tenant escape, credential disclosure, or
  equivalent catastrophic behavior. Stop release and normal feature work.
- **P1 — high:** release-blocking security, correctness, CI-governance, or
  production-evidence gap. Resolve before production launch.
- **P2 — medium:** important reliability, maintainability, operability, or
  architecture gap. Schedule deliberately and prevent further growth.
- **P3 — low:** localized debt or quality improvement with limited immediate
  risk.

A finding is complete only when all stated completion evidence exists. Moving
code, adding an interface, or updating this document does not by itself close a
finding.

## 7. Findings and remediation records

| Finding | Result | Concrete repository evidence |
| --- | --- | --- |
| F-01 | Resolved | `57003e9`, `48c9874`; browser-secret digest, cookie boundary, real HTTP/PostgreSQL replay and upgrade proofs |
| F-02 | Resolved | `461c250` through `15f68ee`, plus `1b5e6eb`; atomic Redis policy across origin/address/actor/workspace/connection, API and provider enforcement, telemetry, exact thresholds, recovery, noisy/quiet fairness and measured overhead |
| F-03 | Resolved | `6496897`, `920d793`; coordinator and attempt stores use the shared hardened tenant transaction engine |
| F-04 | Resolved | `f29fd11`, `79828cc`; requested configuration fails during discovery and CI rejects zero, skipped, pending, or failed required API gates |
| F-05 | Resolved | Versioned governance policy is in `a2c179a`; strict protected-main settings require the ten CI/CodeQL contexts, and PR #2 reported `BLOCKED` when the deliberate `audit/protection-proof` context failed at `18fcb8e` |
| F-06 | Open | Repository exercise profiles and fail-closed evidence schemas exist, but no live AWS, pager, failover, PITR, load, or regional-recovery report has been supplied |
| F-07 | Resolved | `1f226e5`; migration `0072` binds exact slot/application identity and fails closed on zero or duplicate active sessions |
| F-08 | Resolved | `0c0facc`; API management/test and worker resolution factories publish separate narrow capabilities with contract tests |
| F-09 | Resolved | `aca5365`; connection lifecycle persistence is split across management, secrets, resolution, health, testing, and shared transaction modules |
| F-10 | Resolved | `1936490`, `b321e62`; legacy execution runtime, broad exports, dedicated configuration, and uncalled process fixture are removed after successor-store proofs |
| F-11 | Resolved | `97f8854`; bounded SSE visibility histogram, path classification, dashboard, alert, runbook, skew behavior, and load assertion |
| F-12 | Resolved | `ff9a0be`, `b546ecc`; quality, unit groups, coverage, integration, recovery, compatibility, and deployment/security run as isolated CI failure domains |
| F-13 | Resolved | `62e4e32`, `8fe2c9c`; readable tags plus immutable digests, drift validator, and automated reviewed Docker update pull requests |
| F-14 | Repository ownership resolved | `993f849`, `2d7c8fc`; versioned external AWS platform contract, distinct workload roles, strict fresh AWS evidence validator, and 11 enforced drift tests; actual cloud evidence remains F-06 |
| F-15 | Resolved | `1b52f1e`, `a09c6f9`, `6c551b0`, `3748b55`, `a1fe016`, `aa9e334`, `f386ee0`, `d2a8b35`; cited and residual hotspots are behavior-owned suites/fixtures with deterministic database/process barriers |
| F-16 | Resolved | `246a8dd`; critical workflow, database, worker, and API branch thresholds are enforced in CI and pass locally |
| F-17 | Resolved | `1428918`, `297c328`; third-party values are isolated as `unknown`, minimally validated, contract-tested, and the statically fixed OIDC value is not asserted at runtime |
| F-18 | Resolved | `4a00626`; workflow observations are owned by the neutral engine type seam without expanding the package API |
| F-19 | Resolved / ongoing | `6a2f814`; the live inventory records identity, cohorts, fixtures, production removal evidence, owner/review date, removal test, and rollback plan |
| F-20 | Resolved / ongoing | `07109d1`, `b321e62`, and this reconciliation; README commands/package map and this sole audit reflect current code |

Resolved descriptions below retain the original defect and required design so a
future regression has an objective standard. They are not an assertion that the
pre-remediation evidence still describes current code.

### F-01 — Bind OIDC login to the initiating browser

- **Severity:** P1
- **Status:** Resolved on 2026-08-28
- **Area:** identity and security
- **Evidence:** `apps/api/src/identity-workspace/controllers.ts`,
  `apps/api/src/identity-workspace/use-cases.ts`, `apps/api/src/identity/oidc.ts`,
  `packages/database/src/oidc-login-transactions.ts`

The start endpoint now creates an independent 256-bit browser-binding secret,
stores only its SHA-256 digest with the OIDC transaction, and returns the raw
value only to the HTTP cookie boundary. The callback-path cookie is `HttpOnly`,
`Secure` under the deployed cookie policy, `SameSite=Lax`, and bounded by the
transaction expiry. The callback requires the cookie. PostgreSQL locks the
transaction, compares fixed-length digests in constant time, and records
single-use consumption in the same transaction before provider exchange.
Success and every terminal callback failure clear the cookie.

#### Implemented design

1. Generate a separate high-entropy browser-binding secret at login start.
2. Set it in a narrowly scoped, `Secure`, `HttpOnly`, appropriate-`SameSite`
   cookie with a lifetime no longer than the OIDC transaction.
3. Store only a cryptographic digest bound to the transaction state.
4. Require the cookie at callback and compare its digest in constant time before
   exchanging the authorization code or issuing a session.
5. Consume the binding atomically with the OIDC transaction.
6. Clear the binding cookie on success and every terminal callback failure.
7. Never reuse the session CSRF token as the login binding.

#### Completion evidence

- Unit coverage proves digest-only storage, missing/wrong binding rejection,
  successful recovery with the correct binding, replay rejection, expiry, and
  omission of the raw binding from the response body.
- Real PostgreSQL coverage proves a binding mismatch is non-consuming and
  concurrent correct callbacks produce one success and one replay.
- The populated-`0070` upgrade regression proves migration `0071` invalidates
  transactions that cannot possess the new browser secret and enforces the
  non-null fixed-width digest constraint.
- The real Nest HTTP flow carries the cookie from start to callback and checks
  its flags, narrow path, bounded lifetime, success/failure clearing, missing
  and wrong-cookie failure, replay, and response redaction.

### F-02 — Implement the plan's complete rate-limit model

- **Severity:** P1
- **Status:** Resolved on 2026-08-30
- **Area:** security, abuse resistance, and cost control
- **Evidence:** `docs/workflow-platform-backend-plan.md` requires limits per
  actor, workspace, endpoint class, webhook endpoint, and provider connection;
  current repository support is primarily webhook-endpoint ingress limiting.

OIDC start can consume cryptography and database capacity without authentication.
Connection tests, credential rotations, webhook management, workflow publication,
run admission, and other costly operations are authorized but do not all have
the required actor/workspace/endpoint/provider limits. Idempotency prevents some
duplicate effects; it does not limit fresh-key abuse.

#### Required design

1. Create one rate-limit policy vocabulary with bounded endpoint classes.
2. Define explicit keys and limits for unauthenticated origin/IP, actor,
   workspace, webhook endpoint, and provider connection.
3. Place enforcement before expensive KMS, provider, database-count, compilation,
   or queue work where possible.
4. Keep durable business quotas separate from short-window abuse limits.
5. Use deployment ingress/WAF controls only behind a versioned, validated
   contract; do not rely on undocumented external configuration.
6. Return bounded retry information without exposing tenant or resource
   existence.
7. Emit fixed-cardinality allow/reject metrics by endpoint class and limit type.
8. Decide fail-open versus fail-closed per endpoint class in an ADR; identity and
   costly mutation paths should default to fail closed.

#### Verification

- exact threshold, recovery-window, and concurrency tests for every dimension;
- cross-workspace and cross-actor independence;
- no bypass through fresh idempotency keys, alternate routes, or forwarded
  headers;
- proxy trust and client-address parsing tests;
- provider-connection limits cover retries and connection tests; and
- representative load proves limiter overhead and fairness.

### F-03 — Use one hardened tenant transaction engine everywhere

- **Severity:** P1
- **Status:** Resolved on 2026-08-28
- **Area:** tenancy, PostgreSQL pooling, and failure handling
- **Evidence:** `packages/database/src/coordinator-run-store-transactions.ts` and
  `packages/database/src/node-attempt-run-store-transactions.ts` differ from the
  hardened engine in `packages/database/src/workspace.ts`.

The coordinator and node-attempt behavior-named helpers now delegate to the
shared tenant transaction engine. That engine owns pre-use absence checks,
workspace/actor read-back, post-commit cleanup checks, rollback-error
preservation, contaminated-client destruction, abort-driven wire cancellation,
and cancellation while waiting for a pool connection. Its internal
repeatable-read seam preserves stable read snapshots without expanding the
package's public transaction options.

#### Implemented design

Deepen the existing transaction module rather than introducing a fourth helper.
Allow the hardened private engine to accept the required transaction mode:

- ordinary read/write;
- repeatable-read read-only; and
- actor context when authorization requires it.

Coordinator and node-attempt modules should call that engine while retaining
their behavior-named public interfaces. Abort-driven wire cancellation,
read-back verification, aggregate rollback failures, and destroy-on-uncertainty
must be identical across every tenant-scoped pool path.

#### Completion evidence

- Five focused engine regressions prove pre-contamination destruction,
  read-back failure before domain work, aggregate operation/rollback errors,
  acquisition cancellation with late-client destruction, and retained
  read/write transaction modes.
- The existing real PostgreSQL hygiene suite proves commit-path contamination
  destruction, in-flight cancellation, actor/workspace verification, clean
  reuse, and the Drizzle facade on the same primitive.
- Coordinator and node-attempt real PostgreSQL scenarios pass after their local
  transaction implementations are removed.

### F-04 — Make requested integration gates fail rather than skip

- **Severity:** P1
- **Status:** Resolved on 2026-08-30
- **Area:** testing and CI truthfulness
- **Evidence:** `apps/api/test/webhooks/direct-webhook.integration.test.ts`
  requires `DATABASE_ADMIN_URL`; `.github/workflows/ci.yml` enables
  `API_WEBHOOK_INTEGRATION` without defining that URL. CI run `33205516102`
  reports the direct-webhook test skipped.

The implementation tracker claims the HTTP integration runs in CI, but the
gate's boolean silently converts missing configuration into a skip.

#### Required design

1. Provide the disposable-database admin URL in CI.
2. Separate `requested` from `configured` in integration test bootstraps.
3. If a gate is requested and configuration is incomplete, throw during test
   discovery or setup instead of selecting `describe.skip`.
4. Keep intentional environment skips explicit and centrally inventoried.
5. Print an integration-gate summary and fail CI when a required gate reports
   zero executed tests.

#### Verification

- direct-webhook HTTP integration executes in CI;
- the log shows the expected assertion rather than a skip;
- a test proving requested-plus-missing-configuration fails; and
- `implementation-progress.md` records the exact successful run.

### F-05 — Enforce CI before changes reach `main`

- **Severity:** P1
- **Status:** Resolved
- **Area:** repository governance
- **Evidence:** GitHub reported no `main` branch protection and no repository
  rulesets at the audit timestamp.

The workflow is comprehensive, but direct pushes allow broken commits to reach
`main` before results are known. Rapid pushes also cancel earlier CI runs, which
makes historical evidence difficult to interpret.

#### Required design

- protect `main` or install an equivalent repository ruleset;
- require pull requests or a controlled merge queue;
- require current CI and CodeQL checks;
- require branches to be up to date or use a merge queue;
- block force pushes and deletion;
- restrict bypass to a documented emergency group; and
- preserve an auditable emergency process.

#### Verification

Capture the ruleset export or GitHub API response, prove a failing required check
blocks merge, and link the evidence in the tracker. This is an external-state
change and cannot be closed by repository code alone.

#### Resolution evidence

- GitHub's branch-protection API reports strict up-to-date checks, enforced for
  administrators, with pull requests, stale-review dismissal, linear history,
  resolved conversations, and force pushes and deletion disabled.
- The permanent required contexts are `quality`, the three partitioned unit-test
  jobs, `coverage`, `integration`, `recovery`, `compatibility`,
  `deployment-security`, and CodeQL `analyze`.
- Governance reconciliation PR #2 at `18fcb8e` reported merge state `BLOCKED`
  while a deliberate required `audit/protection-proof` status was `failure`.
  That temporary proof context was then removed from the permanent rules; it
  never replaced or weakened a real required check.

### F-06 — Complete live Phase 7 evidence

- **Severity:** P1
- **Status:** Open — external AWS and operational exercises required
- **Area:** production readiness
- **Evidence:** the unchecked Phase 7 rows in `implementation-progress.md`

Repository contracts and local simulations cannot prove the production AWS
control plane, IAM, Object Lock, regional replication, paging, scaling, or
recovery objectives.

Required evidence includes:

- dual-region append-only ledger and restore-before-serve behavior;
- deletion, legal hold, recovery window, purge, versioned objects, and regional
  object behavior;
- deployed dashboards, alerts, and pager routing;
- rendered image, task role, filesystem, migration job, health, and secret
  boundaries;
- API and worker autoscaling under representative admitted load;
- webhook burst, large fan-out, long-wait, and noisy-tenant fairness;
- Redis loss, PostgreSQL failover, provider outage, worker drain, and object
  storage degradation;
- backup/PITR and regional restore drills; and
- measured five-minute RPO and 24-hour regional RTO.

Every report must record immutable application and infrastructure versions,
environment, timestamps, workload, expected and observed behavior, SLO results,
operator actions, cleanup, and unresolved deviations.

### F-07 — Make regional replica identity unambiguous

- **Severity:** P2
- **Status:** Resolved on 2026-08-30
- **Area:** durability and regional admission
- **Evidence:** `packages/database/src/retention.ts` selects one
  `pg_stat_replication` row by `application_name`, ordered by PID.

`application_name` is client supplied. Misconfiguration, a restore drill, or a
second client using the same name can cause the lowest PID rather than the
intended Ireland recovery replica to determine write admission.

#### Required design

- bind monitoring to a unique deployment-owned identity, preferably a dedicated
  physical replication slot plus expected application identity;
- require exactly one matching active replication session;
- fail closed on zero or multiple matches;
- record the stable identity and duplication state without unbounded labels; and
- exercise replacement, duplicate, disconnect, catch-up, and stale evidence.

### F-08 — Publish truly least-capability database interfaces

- **Severity:** P2
- **Status:** Resolved on 2026-08-30
- **Area:** package architecture and compile-time authority
- **Evidence:** `@pertexo/database/execution` exports full
  `ConnectionDatabase` and `WorkspaceDatabase` interfaces.

The role-specific package paths are a good improvement, but import paths alone do
not provide least capability. Worker code needs a small connection-resolution
view, not management, rotation, revocation, health, and connection-test methods.
`WorkspaceDatabase.withWorkspace` also exposes the entire Drizzle schema.

#### Required design

1. Define behavior-named interface views from existing implementations, such as
   worker connection resolution and API connection management.
2. Return the narrow view from each runtime factory or composition module.
3. Avoid wrapper modules that merely delegate; the implementation can remain
   shared internally.
4. Enforce interface imports with package-contract and lint tests.
5. Treat database roles and RLS as the security authority; TypeScript narrowing
   is defense in depth and change-locality support.

### F-09 — Decompose connection persistence by lifecycle

- **Severity:** P2
- **Status:** Resolved on 2026-08-30
- **Area:** readability, cohesion, and testability
- **Evidence:** `packages/database/src/connections.ts` contains a 14-method
  interface and an approximately 1,130-line factory.

The file combines management, idempotent creation, rotation, revocation, worker
secret resolution, current-version fencing, health recording, and asynchronous
connection-test dispatch/completion. The interface is broad and its
implementation changes for several independent reasons.

#### Required design

Extract private modules around durable transaction ownership:

- management and idempotency;
- secret rotation and current-version fencing;
- worker secret resolution;
- health observations; and
- connection-test claim, dispatch, completion, and abandonment.

Keep atomic operations atomic. Centralize row mapping, input parsing, audit fact
creation, and shared transaction hygiene where they own one invariant. Do not
introduce a generic repository, base store, or provider factory.

#### Verification

Preserve all real-PostgreSQL concurrency, CAS, idempotency, RLS, secret-version,
redaction, and dispatch tests. Add interface-contract tests proving API and
worker composition receive only their required methods.

### F-10 — Retire the parallel legacy execution persistence surface

- **Severity:** P2
- **Status:** Resolved on 2026-08-30
- **Area:** obsolete abstractions and drift
- **Evidence:** `packages/database/src/execution-runtime.ts` and its broad root
  exports coexist with the production coordinator and node-attempt stores.

Several legacy execution functions are now consumed mainly by retained Phase 0E
tests, while production uses newer behavior-named stores. Parallel
implementations of claim, heartbeat, completion, retry, wait, and reconciliation
semantics can drift and make tests prove the wrong seam.

#### Required design

1. Inventory every legacy export and production/test caller.
2. Classify each as still authoritative, compatibility-only, or replaceable.
3. Move retained crash and recovery proofs onto the production coordinator and
   node-attempt interfaces.
4. Preserve unique Phase 0E behaviors as characterization tests before removal.
5. Delete exports and implementation only when no persisted-version or supported
   release requires them.

Do not remove compatibility code based only on apparent lack of imports; use the
retirement evidence defined in section 10.

### F-11 — Measure persisted-to-visible event latency

- **Severity:** P2
- **Status:** Resolved on 2026-08-30
- **Area:** observability and SLO enforcement
- **Evidence:** ADR 015 defines p95 persisted-to-visible latency below two
  seconds; no corresponding metric, dashboard, or alert exists.

#### Required design

- define visibility precisely: first successful SSE frame emission for a
  persisted run event;
- calculate latency from the database-created timestamp using a bounded
  histogram;
- distinguish live Redis wake-up, PostgreSQL backfill, reconnect, and recovery
  paths with a bounded path label only if operationally necessary;
- avoid workspace, run, event, user, or URL labels;
- add a dashboard panel, alert, runbook, and load-harness assertion; and
- document clock assumptions and negative/skew handling.

### F-12 — Split CI by failure domain and preserve determinism

- **Severity:** P2
- **Status:** Resolved on 2026-08-30
- **Area:** CI reliability and cost
- **Evidence:** one sequential quality job has a 15-minute timeout; the latest
  success used almost 12 minutes.

#### Required design

Use separate required jobs for:

1. formatting, lint, contracts, build, and typecheck;
2. unit tests partitioned by workspace group;
3. real PostgreSQL/Redis/object-store integration;
4. destructive crash/outage/recovery proofs;
5. compatibility and prior-head migrations; and
6. deployment, exercise, dependency, and image security contracts.

Share dependency setup only where it actually reduces cost. Give database tests
disposable databases or schemas so parallelism cannot create shared-state races.
Upload concise failure logs and test reports. Do not hide a flaky test behind a
retry; repair its synchronization or clock control.

### F-13 — Pin CI service images immutably

- **Severity:** P2
- **Status:** Resolved on 2026-08-30
- **Area:** reproducibility and supply chain
- **Evidence:** Compose defaults include mutable PostgreSQL, Redis, S3Mock, and
  MinIO tags.

Pin the exact tested image digest with a readable version comment. Automate
reviewed updates, run the full migration and failure matrix for updates, and
record old/new versions. Keep local overrides possible without weakening CI.

### F-14 — Complete reproducible deployment ownership

- **Severity:** P2
- **Status:** Resolved for repository ownership on 2026-08-30; live evidence remains in F-06
- **Area:** infrastructure and operations
- **Evidence:** the repository renders ECS task definitions; IAM, networking,
  services, CloudWatch publication/alarms, scaling targets/policies, and some
  recovery fencing remain externally configured.

The current deployment contract is valuable but not a complete reproducible
environment. Before production, either bring these resources into versioned IaC
or define and validate a versioned external-platform contract with drift
detection. At minimum, the release evidence must prove:

- task and execution roles by process;
- network ingress/egress and regional endpoints;
- secret references and KMS permissions;
- service desired count, deployment health, and drain timing;
- metric publication and alarm wiring;
- API/worker scaling targets and policies;
- database migration job exclusivity; and
- recovery-region writer fencing.

### F-15 — Reduce remaining test-suite hotspots and fixed-time sleeps

- **Severity:** P2
- **Status:** Resolved on 2026-08-30
- **Area:** test maintainability and flakiness
- **Evidence:** multiple suites remain approximately 1,700–2,200 lines and many
  real-service tests use fixed sleeps.

Organize tests by invariant and durable transaction, not arbitrary line count.
Use behavior-owned support modules and disposable fixtures. Replace fixed sleeps
with condition polling, observable barriers, fake clocks, or database-clock
advancement where semantics permit. Preserve real process death and real-time
lease/TTL proofs where simulated time would invalidate the evidence.

Candidate suites include execution acceptance, the original engine suite,
connections, preview worker, workflow authoring, and the retained Phase 0E
fixture. A directory is useful only when it establishes behavior ownership; it
is not a solution by itself.

### F-16 — Add coverage as a diagnostic signal

- **Severity:** P3
- **Status:** Resolved on 2026-08-30
- **Area:** testing

The repository has extensive assertions but no coverage command, report, or
threshold. Add coverage for changed code and critical modules. Prefer branch
coverage around security decisions, state transitions, and error handling over a
high global vanity number. Exclude generated and declarative schema code only
through reviewed configuration. Coverage must supplement, not replace,
real-service and failure-mode tests.

### F-17 — Remove or isolate remaining unsafe TypeScript assertions

- **Severity:** P3
- **Status:** Resolved on 2026-08-30
- **Area:** TypeScript and third-party seams
- **Evidence:** JSONata AST/context assertions in
  `packages/workflow-model/src/expressions.ts` and an avoidable OIDC assertion in
  `apps/api/src/identity-infrastructure/oidc-adapter.ts`.

At third-party seams, isolate `unknown` conversion in one adapter, validate the
minimum runtime shape actually consumed, document why upstream types are
insufficient, and contract-test the pinned dependency. Remove assertions where
the value is already statically known. Production double assertions must not be
used to make a type error disappear.

### F-18 — Clarify engine type ownership

- **Severity:** P3
- **Status:** Resolved on 2026-08-30
- **Area:** module design

The extracted engine modules import the `WorkflowObservation` type from the
orchestration file that imports those modules. Runtime imports remain acyclic,
but the type-level strongly connected cluster obscures ownership. Move shared
transition vocabulary to the existing engine types module or another single
neutral owner. Keep orchestration authority in `advanceWorkflow`; do not create a
new public package surface.

### F-19 — Maintain a compatibility-retirement inventory

- **Severity:** P3
- **Status:** Resolved on 2026-08-30; ongoing quarterly control
- **Area:** compatibility and dead-code governance

Phase-coded release history and retained engine identities are not proven dead.
They protect persisted workflows and rolling compatibility, so deletion by
ordinary dead-code analysis is unsafe.

For every retained compatibility path, record:

- persisted or external identity protected;
- first and last supported release;
- reader/writer/worker cohorts requiring it;
- fixtures and migration checks proving it;
- production evidence required before removal;
- owner and review date; and
- exact removal test and rollback plan.

This inventory should distinguish intentional compatibility from accidental
obsolete abstraction and make future cleanup safe.

### F-20 — Keep audit and onboarding documentation current

- **Severity:** P3
- **Status:** Resolved on 2026-08-30; ongoing documentation control
- **Area:** documentation

The previous audit mixed an old baseline, later resolutions, and stale hotspot
tables. The README also refers to Turborepo and `packages/engine`, neither of
which describes the current workspace.

Maintain this file as a current-head document. Historical implementation logs
belong in Git history or phase evidence, not in an active findings list. Update
the README's package map, commands, integration prerequisites, and distinction
between `pnpm check` and real integration gates.

## 8. Area-by-area target state

This section defines the desired engineering standard beyond the individual
findings.

### 8.1 Architecture and module design

#### Preserve

- PostgreSQL as the durable authority;
- Redis/BullMQ as rebuildable transport;
- framework-independent workflow model and engine;
- separate API, worker, retention, lifecycle, recovery, and operator processes;
- role-specific database grants and application composition;
- behavior-named persistence interfaces; and
- centralized transition authority.

#### Improve

- make runtime interfaces least-capability, not merely runtime import paths;
- keep public interfaces small while allowing rich private implementations;
- split modules at invariant and transaction seams;
- reject generic repositories, base services, universal factories, and wrapper
  layers that add naming without hiding complexity;
- place shared types at neutral ownership points; and
- run the deletion test before retaining an abstraction.

#### Done when

Callers learn only the invariants they need, changes remain local to one module,
tests use the same interface as production callers, and package-direction lint
plus contract tests prevent authority creep.

### 8.2 Persistence, transactions, and tenancy

#### Preserve

- forced RLS on tenant tables;
- separate owner, migration, API, worker, dispatcher, maintenance, lifecycle,
  operator, and recovery responsibilities;
- database-clock leases and deadlines;
- atomic outbox/inbox/state changes;
- compare-and-set fencing and immutable facts; and
- fail-closed startup compatibility audits.

#### Improve

- route every pooled tenant transaction through one hardened engine;
- prohibit swallowed rollback and cleanup failures;
- destroy uncertain clients;
- verify context before use, after setting, and after transaction completion;
- keep migrations immutable after release, with forward-only repair as the
  default; and
- add populated prior-head fixtures for every data-changing migration.

#### Done when

Every tenant pool path has identical contamination tests, migration tests cover
real retained rows, and no serving adapter can bypass its role-specific function
or table grants.

### 8.3 Security and identity

#### Preserve

- opaque server-side sessions;
- OIDC initiating-browser binding with digest-only durable state;
- secure cookie and CSRF protections;
- envelope encryption with identity-bound associated data;
- byte wiping and redaction;
- raw-byte webhook HMAC verification and replay protection;
- authorization repeated inside database transactions;
- SSRF DNS/redirect rechecks and bounded HTTP; and
- no user code in V1 workers.

#### Improve

- complete actor/workspace/endpoint/provider rate limits;
- validate trusted proxy configuration;
- continuously test session fixation, login CSRF, logout, rotation, and replay;
- make security-sensitive skipped tests fail when requested; and
- document external WAF/IAM controls as versioned contracts.

#### Done when

Every identity transition is bound to the intended browser and transaction,
every expensive surface has a tested abuse budget, and negative security tests
run in required CI.

### 8.4 Durable execution and compatibility

#### Preserve

- immutable published workflow and executor identities;
- deterministic engine decisions;
- one canonical transition vocabulary;
- side-effect-class-aware reconciliation;
- stable provider idempotency keys;
- outcome-unknown rather than false success/failure; and
- retained fixtures for supported releases.

#### Improve

- migrate legacy Phase 0E proofs to production persistence interfaces;
- maintain the compatibility-retirement inventory;
- keep old readers only while retained data requires them;
- verify every rolling predecessor/head pair; and
- prevent test-only legacy implementations from becoming a second authority.

#### Done when

One production interface proves each durable lifecycle, supported old data
continues to execute exactly, and retirement decisions are evidence-based.

### 8.5 TypeScript and code readability

#### Preserve

- strict TypeScript and type-aware ESLint;
- `unknown` at untrusted inputs;
- Zod validation at runtime seams;
- immutable input/result types;
- explicit domain errors; and
- exhaustive state handling.

#### Improve

- eliminate unjustified double assertions;
- keep parsing, validation, mapping, orchestration, and I/O visibly distinct;
- prefer domain names over phase or implementation names in current code;
- avoid boolean parameter growth and data clumps;
- split long implementations by invariant, not by arbitrary size; and
- keep imports at the top and shared vocabulary in its owning module.

#### Done when

Unsafe casts are isolated and tested, production functions can be understood
without reconstructing unrelated lifecycles, and the interface remains smaller
than the knowledge hidden behind it.

### 8.6 Packages and dependency management

The current packages are justified:

- `contracts` owns external schemas;
- `workflow-model` owns portable workflow representation;
- `workflow-engine` owns deterministic orchestration;
- `node-sdk` owns portable node/executor contracts;
- `nodes-core` owns built-in definitions;
- `node-catalog` composes supported releases;
- `integrations` owns provider adapters;
- `database` owns PostgreSQL persistence;
- `queue` owns Redis/BullMQ transport;
- `observability` owns telemetry primitives; and
- `artifact-store` owns bounded object storage and ledger adapters.

Do not merge packages merely to reduce count. Merge only if two interfaces
cannot vary independently and separation creates more coupling than locality.
Do not add a `shared` package. Narrow exports, keep browser/server conditions
accurate, test published package paths, and remove unused production
dependencies through automated analysis plus human review.

### 8.7 Testing

#### Required layers

- pure unit/property tests for parsers, policies, and engine decisions;
- interface tests through production seams;
- real PostgreSQL tests for RLS, grants, transactions, concurrency, and
  migrations;
- real Redis/BullMQ tests for duplicate delivery and recovery;
- S3-compatible tests for bytes, metadata, checksums, and deletion;
- process-death tests for dispatch uncertainty and lease recovery;
- prior-head and retained-version compatibility tests;
- HTTP-stack tests for authentication, CSRF, validation, and error mapping; and
- production-environment exercises for controls local substitutes cannot prove.

#### Test-quality rules

- requested gates must never silently skip;
- test names state the invariant and failure mode;
- assertions prove durable facts, not just returned values;
- helpers own one behavior family;
- fixed sleeps require a reason;
- mocks stop at genuine seams;
- every bug fix includes a regression at the narrowest truthful layer; and
- coverage is a diagnostic, not a replacement for behavior evidence.

### 8.8 CI, dependencies, and supply chain

CI should be required, partitioned, deterministic, and fast enough to support
review. Pin actions and service images by immutable identity. Keep frozen
lockfiles, production dependency audit, CodeQL, container scanning, non-root and
read-only runtime proof, generated-contract drift, migration tests, and
deployment validation.

Add machine-readable test reports, skipped-gate inventory, duration trends, and
artifacts for failures. Dependency updates should be small, reviewed, and run
through the complete relevant matrix.

### 8.9 Observability

Every accepted SLO needs an emitted metric, dashboard, alert or burn-rate rule,
and runbook. Metrics must use bounded dimensions; never label workspace, user,
run, node, URL, error message, or arbitrary provider response. Logs and traces
may carry carefully redacted correlation identifiers.

Measure user-visible latency from durable acceptance or persistence to the
defined visible outcome, not only internal function duration. Test alert
expressions against emitted series and exercise pager routing in the deployed
environment.

### 8.10 Performance and scalability

Preserve bounded pages, batches, graph sizes, loop limits, event sizes, queue
payloads, and concurrency admission. Add measured profiles for steady load,
bursts, noisy tenants, fan-out, long waits, database failover, Redis recovery,
and provider degradation. Record saturation signals and verify fairness rather
than reporting aggregate throughput alone.

Database indexes and queries should be justified by real access patterns and
`EXPLAIN` evidence for high-volume paths. Autoscaling must use admitted load and
backlog age without treating delayed work as waiting demand.

### 8.11 Deployment and operations

Version the complete environment or its external contract. A production release
must prove image digest, commands, roles, secrets, networks, migrations,
readiness, draining, autoscaling, dashboards, alerts, backups, failover, and
regional restore. Manual recovery steps require dual control, immutable audit
evidence, and rehearsed rollback.

Local MinIO or S3Mock evidence must never be presented as AWS Object Lock, IAM,
or regional-replication proof.

### 8.12 Documentation and governance

- Keep the plan authoritative and the tracker evidence-based.
- Record decisions in ADRs before implementing indexed decisions.
- Keep this audit current rather than appending branch-session journals.
- Link evidence to immutable commits and workflow runs.
- Separate completed repository implementation from live operational proof.
- Do not mark a combined criterion complete while any required clause is open.
- Archive historical detail through Git history or dedicated immutable reports,
  not contradictory active sections.

## 9. Resolved prior audit work

The following earlier findings are genuinely resolved at the audited head and
should not appear as active recommendations:

- startup compatibility is separated from lightweight recurring readiness;
- unrelated retention operations are independently supervised;
- identity tenant/global transactions use the hardened transaction engine;
- coordinator persistence is decomposed behind a small composition interface;
- scheduler advancement is decomposed while transition authority stays central;
- preview and node-attempt persistence are organized by lifecycle stage;
- database packages publish runtime-specific capability paths;
- the three original giant coordinator/engine/worker suites were divided by
  invariant and their largest worker fixture was decomposed;
- Phase 7 implementation and live-evidence checklist rows are separated;
- readiness function-hash governance is documented;
- the preview cleanup dependency has an explicit close capability;
- regional write admission exists and fails closed on stale/unavailable/lagging
  evidence, subject to F-07 identity hardening;
- preview execution and retention deadlines are separate;
- migration `0070` backfills retained rows under forced-RLS conditions; and
- the readiness integration tests call startup compatibility for catalog drift.

These resolutions remain subject to regression tests. They do not erase the new
findings in this audit.

## 10. Compatibility and deletion standard

Before deleting a legacy function, schema reader, release identity, fixture, or
adapter:

1. identify the persisted/external identity it protects;
2. enumerate production and test callers;
3. identify the last supported writer and reader cohort;
4. prove no supported stored data requires it;
5. migrate retained failure proofs to the replacement interface;
6. add a negative test proving the old identity is rejected only when intended;
7. define forward and rollback behavior; and
8. remove code, exports, tests, docs, and metrics in one coherent checkpoint.

Code is not dead merely because static imports are absent. Conversely, a test is
not sufficient reason to retain a second production implementation when the test
can exercise the current production seam.

## 11. Execution result

The four remediation checkpoints were executed as coherent, green commits:

1. Security and transaction correctness: F-01, F-02, F-03, and F-07 resolved.
2. CI truth and reproducibility: F-04, F-12, and F-13 resolved; F-05 is the
   final external GitHub installation.
3. Interfaces and maintainability: F-08, F-09, F-10, F-15, F-17, and F-18
   resolved without weakening production invariants.
4. Observability and deployment ownership: F-11 and the repository-owned part
   of F-14 resolved; F-06 remains the live-environment execution checkpoint.

F-16, F-19, and F-20 are now enforced ongoing controls. Phase 7 must remain in
progress until F-06 has immutable external evidence and independent review.

## 12. Verification matrix for closing this audit

| Area | Minimum closure evidence |
| --- | --- |
| Identity | real HTTP same-browser binding plus login-CSRF, replay, expiry, and redaction negatives |
| Rate limiting | every required dimension, bypass negatives, fixed-cardinality telemetry, and load evidence |
| Tenant transactions | contamination, read-back, rollback failure, abort, destroy-client, and cross-workspace tests |
| Replica admission | zero/one/multiple replica identity, lag threshold, stale, disconnect, and recovery tests |
| Package capability | lint and compile-time contract proving each runtime receives only required methods |
| Connection refactor | unchanged real-PostgreSQL concurrency, idempotency, RLS, secret, and delivery results |
| Legacy retirement | caller inventory, retained-data proof, production-interface failure fixtures, and removed exports |
| CI | required protected checks, zero unintended skips, partitioned jobs, immutable service images |
| Observability | emitted SLO series, dashboard, alert, runbook, expression tests, and deployed pager exercise |
| Deployment | versioned roles/network/services/secrets/scaling/migrations plus drift evidence |
| Production | measured load, failure, PITR, failover, restore, RPO, and RTO reports |
| Documentation | current file measurements, accurate README, linked immutable evidence, no conflicting audit file |

## 13. Release decision

Production release is **NO-GO** at the audited head.

The release decision may become GO only when:

- F-01 through F-06 are complete;
- F-07 and F-11 are complete because they protect accepted regional and SLO
  claims;
- required CI and CodeQL checks are enforced and green;
- the release workflow has completed successfully for the release commit;
- every Phase 7 live exercise is complete with retained evidence;
- no unresolved P0/P1 independent review finding remains; and
- the tracker and this audit match the exact release head.

P2/P3 maintainability work that does not protect a release invariant may be
scheduled after launch only with an explicit owner and milestone. Security,
tenancy, durable correctness, CI truthfulness, and claimed production SLO work
may not be deferred by lowering its label.

## 14. Maintenance protocol

When this audit changes:

1. record the exact audited commit;
2. rerun or link the evidence relevant to changed findings;
3. update scores only after evidence changes;
4. keep resolved items in the concise resolved register;
5. add new findings to the prioritized register with verification criteria;
6. update `implementation-progress.md` without marking incomplete plan criteria
   complete;
7. obtain independent correctness/security and architecture/test review for P0
   or P1 closure; and
8. commit and push the audit as one coherent documentation checkpoint.

This file should remain a decision document. Detailed command transcripts,
session diaries, superseded hypotheses, and branch-by-branch commit journals
belong in Git history or immutable evidence artifacts rather than here.
