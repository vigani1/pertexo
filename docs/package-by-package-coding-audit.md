# Package-by-package coding audit

## Current whole-backend assessment — 2026-09-09

**Status: implementation complete in the uncommitted worktree. WB-01 through
WB-10, MC-01 through MC-05, TQ-01 through TQ-05, and MH-01 are resolved with
focused and combined verification recorded in the closeout below. The reviewed
baseline remains the historical 7/10 assessment; this remediation does not
silently substitute a new whole-repository score.**

The backend has a strong foundation in explicit contracts, tenant isolation,
durable execution and real integration tests. It is not a clean correctness
sign-off: composition and lifecycle failures remain, including a notification
assumption that blocks a legitimate timeout. Targeted corrections and removal
of redundant construction/validation paths are warranted; a wholesale rewrite
is not supported by the evidence.

Reviewed baseline: `9a09ccec09fa97215f54ed46a687cb00805dd4f6`, tree
`548df4948a1d3c4e4c91eec902b726ef27b15457`, local `main` (one commit ahead
of `origin/main` when this review began). The working tree was clean. This
assessment covers the existing backend, not only the most recent fixes. It
does not authorize implementation changes, commits, pushes, deployment, or
deletion of historical documents.

This is the canonical document for the current assessment. Earlier sections
below remain historical evidence for their recorded revisions; their completed
statuses and scores do not certify the current baseline. Other audit documents
were checked for still-relevant evidence and supersession, not duplicated
into a new report series. Removing superseded documents requires agreement and
a reference check.

### Review method and completion rule

- Account for every tracked application, package, test/configuration area,
  migration area, repository tool, infrastructure definition and document.
- Inspect responsibilities, module depth and interfaces, dependency direction,
  ownership, domain invariants, types/naming, control flow, duplication and
  unnecessary state. Large files are prompts to inspect cohesion, not automatic
  findings; small pass-through files are not automatic successes.
- Check correctness, security/tenancy, contracts, transactions/concurrency,
  cancellation/timeouts/retries, resource cleanup, observability and bounded
  performance at each relevant area.
- Trace complete workflows across owners: identity/workspace access,
  authoring/publication, execution/recovery, triggers, connections/artifacts,
  and retention/deletion.
- Review tests for meaningful assertions, fault detection, realism, redundant
  protection, brittleness, isolation and coverage exclusions. Passing a test
  suite is distinct from manually reviewing it; reviewed uncovered branches
  remain uncovered.
- Consolidate symptoms by root cause. Each finding needs evidence, impact,
  confidence, a coherent correction (including what it replaces/removes), and
  closure criteria. Distinguish blockers, maintainability improvements,
  intentional complexity and unverified external assumptions.
- Finish only when every inventory row has a supported disposition and all
  verification results/gaps are recorded. Do not truncate findings to a quota
  or call sampled inspection exhaustive. Scores follow the assessment.

### Current inventory and inspection ledger

Counts reconcile to all 1,471 tracked files at the baseline. Source/test counts
include all files under those directories, including fixtures; other files include local
configuration, tooling and generated contracts. Database other files include
85 forward migrations plus the `0000` probe. Inspection completion is not an
unconditional quality pass. Authored code and tests require full-body inspection;
generated artifacts require structural/semantic validation. Historical prose
is inventoried and checked for relevance and references, not represented as a
fresh line-by-line review of every historical narrative.

| Area | Source files | Test/support files | Other tracked files | Current inspection |
| --- | ---: | ---: | ---: | --- |
| API | 145 | 89 | 8 | Full source/test/config inspection complete |
| Worker | 54 | 76 | 7 | Full source/test/config inspection complete |
| Lifecycle command | 4 | 7 | 5 | Full authored-file inspection complete |
| Operator command | 3 | 2 | 4 | Full authored-file inspection complete |
| Recovery | 3 | 2 | 4 | Full authored-file inspection complete |
| Retention | 5 | 3 | 4 | Full authored-file inspection complete |
| Artifact store | 15 | 13 | 6 | Full authored-file inspection complete |
| Contracts | 25 | 9 | 25 | Authored source/tests inspected; generated contracts validated |
| Database | 169 | 172 | 95 | All source/test bodies and 86 numbered SQL files inspected; configuration validated |
| Integrations | 32 | 9 | 5 | Full authored-file inspection complete |
| Node catalog | 5 | 6 | 5 | Full authored-file inspection complete |
| Node SDK | 10 | 2 | 5 | Full authored-file inspection complete |
| Core nodes | 57 | 7 | 5 | Full authored-file inspection complete |
| Observability | 11 | 11 | 5 | Full authored-file inspection complete |
| Queue | 12 | 13 | 6 | Full authored-file inspection complete |
| Rate limit | 4 | 3 | 5 | Full authored-file inspection complete |
| Workflow engine | 48 | 28 | 5 | Full source/test/config inspection complete |
| Workflow model | 22 | 10 | 5 | Full source/test/config inspection complete |
| Root, CI and infrastructure | — | — | 100 | Authored files inspected; generated baselines/lockfile validated |
| Documentation | — | — | 81 | Inventoried; current contracts/relevant ADRs inspected; historical material reference-checked |

### Current verification ledger

| Check | Evidence/status | Limit |
| --- | --- | --- |
| `pnpm check` | Passed on the exact implementation immediately before baseline commit | Build, lint, static gates, contracts, test typechecks and unit suites; not integration or whole-codebase coverage |
| `pnpm test:coverage` | Fresh run passed; 121 selected files / 5,110 coverable lines; 457 reviewed and 23 unreviewed uncovered branches | Positive include lists exclude substantial production code; classifications are not executed tests |
| Local integration | Fresh isolated run passed: artifact store 5, queue 1, database 407, worker 30, API 33 (476 passed total); database coverage merge passed | Three AWS-only artifact tests and one API compatibility-rollout test skipped; specialized resilience/rollout cohorts and real AWS/provider behavior are separate |
| Specialized local integration | Fresh isolated API SSE Redis-loss, worker transport recovery, and API compatibility-rollout cohorts each passed (3 additional tests) | The previously skipped local compatibility test is now executed; three AWS-only artifact tests remain unexecuted |
| Manual module/test inspection | Complete across all application/package source and test/support bodies, including 169 database source files, 172 database test/support files and 86 numbered SQL files | Generated artifacts structurally/semantically validated; historical prose has the separate disposition above |
| Report verification | Prettier check, `git diff --check`, and `pnpm docs:check` passed (13 tests, 302 local links across 81 documents) | Documentation validation does not prove runtime correctness; its historical audited-tree label is not this review's baseline |

The temporary integration Compose project and its five disposable volumes were
removed after the run; the user's existing Compose services were not targets.

### Confirmed current findings

These are current-baseline findings, not copied historical issues or a
quota-limited selection. Nine are P2 and one is P3. The descriptions and root
corrections record the reviewed baseline; the later closeout records the
implemented remediation without rewriting that evidence.

#### WB-01 — Framework errors are swallowed by feature fallback mapping (P2)

`apps/api/src/platform/http/problem-details.filter.ts` calls route-specific
application mappers before handling `HttpException`. The mappers selected by
`apps/api/src/application-error-mappers.ts` generally return
`internal.unexpected` for an unrecognized exception, so the framework fallback
is unreachable for those URLs. A fresh injection through the built Nest/Fastify
application returned 404 for `/nonexistent`, but 500 for
`/v1/workspaces/nonexistent` and an unknown nested workflow URL. These are
unknown routes, not failed database operations.

Root correction: make error normalization a single coherent decision chain:
preserve explicit framework HTTP errors and allow feature mappers to decline
unknown failures before applying the final generic fallback. Replace tests that
exercise framework and feature normalization only in separate configurations
with an additional composed-app matrix across route families and statuses.
Closure: unknown routes remain 404 and explicit 400/401/403/404/503 framework
responses retain safe problem semantics with all real mappers installed.

#### WB-02 — Application-error recognition accepts inherited catalog names (P2)

`apps/api/src/platform/http/application-error.ts:isApplicationError` uses
`code in APPLICATION_ERROR_CATALOG`. The real function accepts
`{ code: 'constructor' }`, `{ code: 'toString' }`, and `{ code: '__proto__' }`.
The problem filter then reads catalog fields from inherited objects/functions,
which do not define a valid problem status/title/type. This is a malformed-error
containment defect; no unauthenticated exploit path is claimed.

Root correction: recognize only own catalog entries and send unrecognized
error-shaped values through the generic unknown-error path. Closure:
table-driven inherited-name and ordinary unknown-error tests produce valid
generic 500 problems without throwing from the filter; existing optional-field
sanitization remains intact.

#### WB-03 — A synchronous logging failure prevents the problem response (P2)

`apps/api/src/platform/http/problem-details.filter.ts:409–427` evaluates
`logger.log(...)` before `Promise.resolve(...)`, so its rejection handler cannot
contain a synchronous exception. The production logger adapter calls Pino
synchronously. A worker reproduced a synchronous throw from the installed Pino
version with a failing destination; a primary-agent probe of the built filter
with a throwing logger recorded zero response sends and propagated the sink
error. The current test covers only a returned rejected promise.

Root correction: isolate the entire logging invocation, including synchronous
failure, from response emission. Keep the response contract independent of the
diagnostic sink; test both thrown and rejected logging failures. Closure: the
original safe problem is sent exactly once in both cases.

#### WB-04 — SSE authorization races retain one pending reaction per frame (P2)

`apps/api/src/workflow-runs/use-cases.ts:251–264` attaches another `.then()` to
the same unresolved `authorizationLost` promise on every iteration. Winning
`Promise.race` with a frame does not detach the losing reaction. On the actual
built `StreamRunEventsUseCase`, 10,000 frames registered 10,000 callbacks on
that one promise, with none executed while authorization stayed valid. A
separate GC-enabled probe grew from 37.7 MiB at 5,000 frames to 68.4 MiB at
20,000 frames. The heap observation also includes other per-frame runtime
allocations; the callback count directly confirms this specific retention.

Root correction: give each producer wait a removable cancellation subscription
owned by that wait, preserving the independent authorization deadline and
backpressure safeguards. Merely moving `.then()` outside the loop still leaves
`Promise.race` subscriptions on a long-lived pending promise. Closure: a long
authorized stream has bounded pending cancellation observers, and the existing
expiry, stalled-lookup, disconnect and backpressure regressions still pass.

#### WB-05 — An in-flight readiness check can recreate the shutdown marker (P2)

`apps/worker/src/runtime/worker-readiness-monitor.ts:31–49` clears its interval
and removes the marker during shutdown, but neither invalidates nor awaits the
check already in flight. That check can subsequently call `setReady(true)`.
`WorkerReadiness.checkReadiness()` checks the drain state only before its
asynchronous dependency checks. A primary-agent probe of the built monitor,
redirecting only the marker path to a disposable directory, confirmed that the
marker exists after shutdown when the outstanding readiness promise resolves.

Root correction: make the monitor own both scheduling and completion of its
current check, with a terminal stopping state and ordering that prevents a
late successful write after final removal. Closure: deferred success, deferred
failure and shutdown-during-write tests leave no readiness marker and no timer;
the application must not report ready while draining.

#### WB-06 — Connection-test dispatch drops the request cancellation signal (P2)

`apps/api/src/connections/connection-testing.ts:113–182` forwards no signal to
the HTTP, Slack or email client, although all three client interfaces support
one. The controller supplies a disconnection/deadline signal, but the use case
uses it only for decryption, unlike create/rotate which also check for abort
after encryption. Consequently a request aborted during or after decryption
can still commit dispatch evidence and contact the provider under a fresh
15-second timeout.

A primary-agent probe through the built use case aborted immediately after
decryption and observed `requestAborted: true`, no client signal, one dispatch
and a successful result. Provider I/O was replaced with a recording client; no
external request was made. The missing signal is also present at the real
production call sites, whose clients honor supplied cancellation.

Root correction: retain one request-owned signal across decryption and provider
dispatch, forward it to all three clients, and check it before initiating
dispatch. Preserve durable dispatch/ambiguity handling for cancellations after
dispatch. Closure: disconnect/deadline before dispatch prevents provider I/O;
abort during I/O reaches the client; completed idempotent replay still requires
neither decryption nor provider contact.

#### WB-07 — Image-pin gate misses YAML environment overrides (P2)

`infrastructure/validate-image-pins.mjs:8–22` recognizes `image:` and dotenv
`*_IMAGE=...`, but not the `*_IMAGE: ...` mappings used by
`.github/workflows/ci.yml:66–69`. The current values are digest-pinned; the
defect is that the advertised gate would accept their replacement with mutable
tags. A primary-agent probe returned no errors for
`POSTGRES_IMAGE: postgres:latest`, while the equivalent dotenv assignment was
correctly rejected. The environment-override test is positive-only.

Root correction: inspect the actual YAML and dotenv representations used by
the checked contracts, preferably through their structural parsers, and test
negative mutations in each supported format. Closure: removing any of the CI
image digests fails `images:check`, while approved dynamic release references
retain their explicitly documented treatment.

#### WB-08 — Control-ledger isolation omits the recovery artifact bucket (P2)

`packages/artifact-store/src/control-ledger-config.ts:55–113` rejects both
ledger buckets when equal to `ARTIFACT_STORE_BUCKET`, but never compares them
with `ARTIFACT_STORE_RECOVERY_BUCKET`. The built parser accepted a recovery
ledger configured to use that recovery artifact bucket. ADR 013 requires a
dedicated control ledger; artifact and immutable-control retention policies
must not accidentally share the same storage location. No current deployed
collision or data loss is claimed.

Root correction: validate the complete set of configured artifact/control
storage locations in the composition/configuration owner, instead of extending
individual primary-only checks one at a time. Keep supported local endpoints
and independent regional credentials intact. Closure: a matrix of primary and
recovery ledger/artifact collisions fails before any clients are opened, and
valid dedicated regional locations pass.

#### WB-09 — Repeated header definitions drift from runtime validation (P3)

The contract builders repeat header grammar independently of the runtime:
`workflow-runs.ts:68–73`, `workflow-authoring.ts:182–188` and
`node-testing.ts:102–107` allow CSRF tokens up to 512 characters, whereas
`apps/api/src/identity/csrf.ts:12` accepts 16–256. Schedule/webhook definitions
allow a one-character token, and artifact transfer has no maximum. Some
idempotency-header definitions omit the runtime printable/no-comma restriction.
`packages/contracts/src/webhooks.ts:174–177` advertises a Content-Type prefix
pattern that accepts `application/jsonevil`, which ingress correctly rejects.
Regeneration passes because it faithfully reproduces those handwritten inputs;
it is not proof that runtime and documentation agree.

Root correction: share transport-owned header schemas and derive repeated
OpenAPI parameters from them, with runtime-versus-contract acceptance cases at
the grammar edges. Replace redundant literal definitions; do not add another
parallel validator. Closure: the generated documents and runtime agree on
CSRF lengths, idempotency characters and supported webhook media types, with
case/parameter handling represented intentionally.

#### WB-10 — Notification context prevents a node-free run timeout (P2)

`packages/database/src/execution/coordinator-run-store-terminal.ts:54–71`
requires a failed/timed-out/outcome-unknown invocation for every notifiable
terminal run. A run can time out while still queued, before any invocation
exists. The actual engine produced a valid `timed_out` plan containing only
`run.timed_out` and zero invocations; passing that plan to the actual
`persistFailureNotificationIntent` accepted an absent policy but threw
`CoordinatorRunStateCorruptError` with policy version 1, before its first query.
`persistCoordinatorRunTransition` calls this function before writing the
checkpoint and terminal run state, in the same transaction. Consequently an
enabled notification policy prevents this legitimate timeout from committing.

Root correction: model run-level failure separately from node failure in the
notification context and its consumers, without inventing a failed node or
weakening terminal-state atomicity. Replace the unconditional node-primary
assumption with an explicit run-level timeout representation. Closure: a
queued deadline commits exactly one terminal event and notification intent
with a truthful context; replay is idempotent, and existing node-failure,
cancellation-suppression and delivery tests remain valid. The engine already
tests pre-materialization deadlines; the missing regression crosses that
behavior with enabled notification persistence.

**Resolved 2026-09-09:** ADR 022 now records a backward-compatible strict
primary-failure union: existing node contexts retain their original shape and
node-free queued timeouts use an explicit run-level timeout shape. Persistence
creates that truthful context without querying or inventing a node, while the
worker renders run scope explicitly. A red-before-fix database integration now
proves one atomic terminal event/intent/outbox and idempotent replay; the full
workflow-model suite, focused worker delivery/handler suites, database unit
suite, and the complete scheduling integration file pass.

### Structural improvements — separate from correctness findings

These recommendations use the codebase-design and architecture-review skills:
improve locality and leverage at an existing seam, and specify what disappears.
They are not permission to implement, introduce new architectural decisions, or
reopen settled ADRs. The requested single Markdown report replaces the skill's
default separate HTML presentation.

| Recommendation | Evidence and friction | Coherent replacement and test effect | Strength |
| --- | --- | --- | --- |
| One problem-normalization module | `platform/http/problem-details.filter.ts`, `application-error-mappers.ts`, and feature error mappers spread classification/fallback ordering across owners; WB-01–03 show failures at their composition | Retain feature-specific domain mappings, but give one module ownership of precedence, unknown errors and diagnostic failure containment. Replace redundant fallback branches with composed HTTP-response tests; keep mapper tests for actual domain distinctions | Strong |
| One owner for each long-lived async operation | SSE authorization waits, worker readiness, and connection-test dispatch lose observer cleanup, stopping state, or the parent signal (WB-04–06) | Deepen each existing operation's lifecycle, with explicit cancellation and completion ownership. Remove uncancelled waits and alternate timeout ownership. Test deferred completion and cancellation through the public operation, not only extracted timer helpers. Do not build a universal lifecycle framework for three different domains | Strong |
| Remove alternate dependency construction paths | `identity-workspace/module.ts` registers OIDC, session and user controllers both as controller entries and factory providers. Authoring and connection modules register persistence/telemetry/encryption/catalog tokens while constructing use cases directly from the supplied dependencies; those tokens have no consumers in production source | Choose one construction path per module. Remove unused provider registrations/tokens and redundant controller factories where Nest's controller construction already supplies the dependencies. Preserve authorization tokens actually injected by guards. Verify the composed module's routes and dependency identities; do not add more factories just for uniformity | Strong |
| Narrow use-case persistence requirements | `identity-workspace/use-cases.ts` accepts `IdentityWorkspacePersistence` even for current-user lookup; authoring use cases accept the entire nine-operation authoring port. Existing lifecycle/restore use cases already use narrower `Pick`s | Express each use case's actual capability with an ordinary `Pick` or small existing contract. Keep one real database adapter; remove irrelevant test stub methods and broad casts. This improves the interface without creating an adapter/class/file per operation | Worth exploring |
| Keep transport parsing out of destination orchestration | `connections/failure-notification-destinations.ts` houses controllers and application orchestration, with use cases consuming the HTTP-shaped request | At the existing feature seam, let controllers supply explicit actor/command data and let orchestration own destination policy. Remove request-header knowledge from application tests. Preserve transaction-time database authorization; this is not a reason to move tenant authority into controllers | Worth exploring |
| Deepen database capability owners without fragmenting transactions | `retention.ts` combines scheduling, lag/readiness, reaping, rerun handling and enforcement; connection persistence combines several caller roles. Coordinator files already split planning, physical-state validation, settlement and commit | Group by independently consumed capability and keep shared transaction invariants together. Remove type-only root/child contract cycles where a leaf-neutral contract clarifies ownership. Do not split every SQL statement into a module or hide fencing behind generic repository methods. Preserve integration tests at the real transaction seam | Worth exploring |

The first recommendation is the highest-leverage structural follow-up: three
confirmed failures share the same error-response composition. WB-10 separately
requires correcting a domain assumption across engine, persistence and delivery,
not merely catching the exception in the coordinator.

### Test-quality assessment — established evidence

The suite provides substantial real protection: fresh database integration
executes RLS, grants, leases, replay and retention against PostgreSQL; transport
cohorts exercise Redis loss and recovery; API injection tests exercise real
Nest/Fastify routing. Deterministic clocks, deferred promises and recording
adapters are appropriate for cancellation and dispatch-order contracts. Mocks
are not intrinsically low value, nor are repeated security checks redundant
when they protect different entry points.

The confirmed gaps are primarily combinations missing at the same seam:
framework errors with real feature mappers; synchronous versus asynchronous
logging failure; repeated SSE frames while authorization remains pending;
readiness success after shutdown; abort after decryption; and a queued deadline
with enabled failure notifications. Add these behavioral regressions as part of
their fixes, replacing assertions that merely repeat an implementation detail
where the stronger test subsumes them. Do not delete meaningful corruption,
tenant-isolation, fencing or recovery matrices to reduce test count.

Coverage is explicitly selected-file coverage, not a whole-backend percentage.
For example, API coverage includes selected identity/HTTP/rate-limit/workspace
files but excludes substantial OIDC, feature orchestration, SSE and bootstrap
code; worker coverage includes four selected execution files but not the
readiness monitor. The database unit cohort is similarly narrow and is
supplemented by separate integration coverage. The report's 457 reviewed
uncovered branches are classifications, not 457 newly executed branches.
`report-risk-coverage.mjs` checks named integration evidence and source
fingerprints, but a named test's presence does not prove a current run passed.
Its global report permits unreviewed branches outside the specifically enforced
lifecycle-command cohort. Keep these scope labels visible and add missing
high-risk modules deliberately; do not raise baselines or relabel uncovered
branches as a substitute for fault-detecting tests.

No mutation-test score, production workload benchmark, live AWS qualification,
or real provider end-to-end success is claimed by this assessment.

Concrete low-value-test cleanup: `nodes-core/test/package-contract.test.ts`
asserts that each node has three specifically named files. That protects a
layout, not the executable contract, and makes a cohesive refactor fail without
a behavior regression. Its entry-source regexes, and the Node SDK test named
"transitive source imports", do not traverse all transitive imports. Replace
those checks with the existing dependency-graph gate where it expresses the
rule, or a browser-entry build/import-graph check. Keep exact export-condition
tests, independently pinned release fingerprints, public-registry execution
matrices, hostile JSON tests and dispatch-marker concurrency tests: these
protect observable compatibility and safety, not merely the current layout.

### Actionable non-bug backlog — implementation and closure details

This section makes the structural and test concerns actionable; it does not
add them to the ten confirmed correctness findings. All items are **open**.
Line references describe baseline `9a09ccec`; named symbols/test titles are
the stable locator if lines move. Paths below are repository-relative.

**Classification:** “cleanup” means observed unnecessary coupling or brittle
protection with a bounded replacement; “design proposal” means the friction is
real but an interface decision must be settled before moving code; “assurance”
means evidence or measurement is incomplete, not that the unmeasured code is
known to be wrong; “hardening” means preventing a configuration mistake, not a
demonstrated attacker-controlled exploit.

The six structural-summary rows are not six additional bugs. Error normalization
is already tracked by WB-01–03 and async ownership by WB-04–06; their structural
work must be closed with those fixes, not charged twice. The remaining rows are
expanded below, together with the test-quality concerns. Preserve all existing
behavior unless a separately identified correctness finding requires a change.

| Concern raised in the assessment | Detailed work item | Classification |
| --- | --- | --- |
| Redundant dependency construction | MC-01 | Cleanup |
| Oversized use-case persistence interfaces | MC-02 | Cleanup |
| HTTP-coupled destination orchestration | MC-03 | Cleanup |
| Mixed retention responsibilities | MC-04 | Design proposal |
| Root/child type-contract ownership | MC-05 | Cleanup; connection-role clarification included |
| File-layout assertions | TQ-01 | Cleanup |
| Incomplete transitive-import assertions | TQ-02 | Cleanup |
| Unmeasured API orchestration | TQ-03 | Assurance |
| Unmeasured worker lifecycle | TQ-04 | Assurance |
| Risk-review versus execution evidence | TQ-05 | Assurance/policy decision |
| Exercise target path validation | MH-01 | Optional hardening |

These are the specific non-bug concerns behind the assessment, not undisclosed
point deductions. The remaining per-area “preserve/avoid” guidance is not a
hidden cleanup list: no blanket renaming, new framework, generic repository,
immutable-version deduplication or coverage-only test deletion is requested.
Live AWS/provider qualification is a separately recorded verification limit,
not a local refactor that can be checked off here. The headline score remains
subjective; it must not substitute for closing individual items with evidence.

#### MC-01 — Remove unused and duplicate API dependency registrations (cleanup)

- **Exact targets:** `apps/api/src/identity-workspace/module.ts:190–219`
  registers `OidcController` and `SessionController` as factory providers,
  while `:223–229` also lists them in `controllers`. The `UserController`
  factory in `identityReadProviders` at `:273–278` repeats the same pattern.
  `apps/api/src/workflow-authoring/module.ts:56–78` registers persistence,
  telemetry and definition-catalog tokens despite passing those dependencies
  directly into use-case instances. `apps/api/src/connections/module.ts:39–45`
  similarly registers persistence, encryption and telemetry tokens with no
  production consumers. This is redundant construction/configuration, not a
  claim that requests execute twice.
- **Change:** retain Nest controller registration and remove the three unused
  controller factory-provider entries after confirming their constructor
  injection metadata. Retain the existing explicit use-case construction in
  authoring/connections and remove the unused registrations plus the unused
  declarations/imports in their respective `tokens.ts` files:
  `WORKFLOW_AUTHORING_PERSISTENCE`, `WORKFLOW_AUTHORING_TELEMETRY`,
  `WORKFLOW_DEFINITION_CATALOG`, `CONNECTION_PERSISTENCE`,
  `CONNECTION_ENCRYPTION`, `CONNECTION_TELEMETRY`.
- **Follow the dead catalog plumbing to its source:** remove the now-unused
  `WorkflowAuthoringDependencies.definitionCatalog` in
  `apps/api/src/workflow-authoring/ports.ts:24–32` and its forwarding through
  `apps/api/src/platform/workflow/workflow-runtime.module.ts:272–273,323–328`.
  Remove the latest-catalog convenience projection only if no consumer remains.
  Preserve per-release `definitionCatalog` and `placementDefinitionCatalog`
  inside `coreAuthoringOptions` (`:219–226`); the database compiler uses them.
- **Preserve:** `WORKFLOW_AUTHORING_AUTHORIZATION`, `CONNECTION_AUTHORIZATION`
  and identity tokens actually injected by guards/controllers/services. Do
  not convert every existing `useValue` into a factory merely for consistency,
  or remove legitimate provider aliases without a separate consumer check.
- **Tests/closure:** use the composed API bootstrap/feature tests to prove
  OIDC, session, current-user, authoring and connection routes still resolve
  the intended dependencies and enforce guards. Check registration uniqueness
  only where it tests the duplicate-construction contract, not an exact array
  ordering snapshot. Search all source/tests for removed token consumers,
  update obsolete test setup and run API tests/typecheck plus dependency and
  architecture gates. Success means less construction machinery with unchanged
  routes, dependency identity and lifecycle ownership.
  Concrete module-test owners are
  `test/identity-workspace/nest-module.test.ts:82–101`,
  `test/workflow-authoring/module.test.ts` and
  `test/connections/module.test.ts:49–66` under `apps/api`;
  `test/connections/http-stack.test.ts` supplies real route composition.

#### MC-02 — Narrow API use-case persistence contracts (cleanup)

**Targets:** constructor dependencies in
`apps/api/src/identity-workspace/use-cases.ts:69–275`,
`apps/api/src/workflow-authoring/use-cases.ts:88–296`, and
`apps/api/src/workflow-runs/use-cases.ts:88–223`. The following is the actual
method requirement, not a proposed interface per SQL statement:

| Owner / use case | Required persistence methods |
| --- | --- |
| Identity: `GetCurrentUserUseCase` | `findUserById` |
| Identity: `ListWorkspaceMembersUseCase` | `listWorkspaceMembers` |
| Identity: `CreateWorkspaceUseCase` | `createWorkspaceWithOwner` |
| Identity: `WorkspaceLifecycleUseCase` | `requestWorkspaceLifecycleOperation`, `readWorkspaceLifecycleOperation` |
| Authoring: `ListWorkflowsUseCase` | `listWorkflows` |
| Authoring: `CreateWorkflowUseCase` | `createWorkflow` |
| Authoring: `GetWorkflowDraftUseCase` | `getDraft` |
| Authoring: `SaveWorkflowDraftUseCase` | `saveDraft`, `getDraft` (including conflict handling) |
| Authoring: `ValidateWorkflowDraftUseCase` | `getDraft` |
| Authoring: `PublishWorkflowUseCase` | `publishWorkflow` |
| Authoring: `ListWorkflowVersionsUseCase` | `listVersions` |
| Runs: `StartWorkflowRunUseCase` | `start` |
| Runs: `ReplayWorkflowRunUseCase` | `replay` |
| Runs: `GetWorkflowRunUseCase` | `get` |
| Runs: `CancelWorkflowRunUseCase` | `cancel` |
| Runs: `StreamRunEventsUseCase` | `get` (its event reader/authorization dependencies remain separate) |

- **Problem:** constructors currently require broad persistence ports rather
  than the methods above. Tests must supply irrelevant members or weaken
  typing, and future use cases can accidentally depend on unrelated behavior.
- **Change:** use ordinary `Pick<ExistingPort, ...>` at these constructors
  or a small feature-local alias when reused. Keep each real adapter and
  composition factory intact. Do not split the database, invent a class/file
  for each `Pick`, or narrow away session methods needed by the actual session
  service. Existing narrow restore/lifecycle authoring ports are precedents,
  not targets to widen.
- **Dead aggregate member:** remove unused `getVersion` from the API's
  `WorkflowAuthoringPersistence` in `apps/api/src/workflow-authoring/ports.ts:10–22`.
  Remove its stubs/assertions in `test/workflow-authoring/use-cases.test.ts`,
  `test/workflow-authoring/module.test.ts` and `test/support/api-platform.fixture.ts`
  under `apps/api`. Keep `getVersion` in the database's own public contract
  and the full database fixture in `apps/api/test/api-bootstrap.test.ts:124–140`;
  they have a different, legitimate surface.
- **Tests/closure:** update the three feature `test/.../use-cases.test.ts`
  suites so focused construction compiles with only the listed methods.
  Remove broad casts/unrelated no-op stubs where narrowing makes them
  unnecessary; retain shared full fixtures where a test genuinely exercises
  several use cases. API test typecheck and behavior suites must pass,
  including save-conflict fallback, authorization-before-persistence,
  idempotent replay, lifecycle polling and stream visibility checks. Adapter
  lifecycle/close remains owned by composition, never by a single use case.
  In `apps/api/test/identity-workspace/use-cases.test.ts:65–82`, session/identity
  stub methods can disappear from focused use-case fixtures; retain them in
  `test/identity-workspace/nest-module.test.ts` where full composition needs them.

#### MC-03 — Separate notification-destination commands from HTTP requests (cleanup)

- **Exact target:** `apps/api/src/connections/failure-notification-destinations.ts`:
  `DestinationRequestInput` carries `HttpConnectionRequest`;
  `FailureNotificationDestinationUseCases` calls `command` and
  `idempotentCommand` with `input.request` in create/list/get/append/status/
  setPolicy/clearPolicy. The same file contains the Nest controllers and
  transport validation helpers. The problem is transport coupling, not simply
  that the file is long or contains several classes.
- **Change:** let controllers parse headers, validate path/body inputs and
  extract authenticated actor/request context. Pass explicit command metadata
  using the existing `ConnectionCommandInput` vocabulary from
  `apps/api/src/connections/use-case-support.ts:19–27` (`actor`,
  `routeWorkspaceId`, optional request/trace identifiers), plus an explicit
  idempotency key for mutations and typed operation data. Map actor/workspace
  identifiers to the unchanged database command shape inside orchestration.
  Keep canonical request-hash construction in the command owner so all callers
  use the same semantic payload. Move use cases and their input types to a
  feature-local application module if needed; leave HTTP decorators/parsing in
  the controller module. Preserve current external exports with a re-export
  where appropriate, not duplicate implementations.
- **Preserve:** exact operation/scope/hash semantics, generated destination
  identity and replay behavior, response schemas/statuses, telemetry, session
  and CSRF guards. Transaction-time membership/workspace/user checks in
  `packages/database/src/execution/failure-notification-destinations.ts`
  remain authoritative; extracting an actor is not replacing authorization.
- **Tests/closure:** application tests invoke all seven operations using typed
  command data without manufacturing HTTP headers or `HttpConnectionRequest`.
  Controller/injection tests prove missing/duplicate/invalid idempotency
  headers, malformed bodies and unauthenticated/forbidden requests retain
  their current responses. Database integration still proves same-key replay,
  mismatched-key conflicts, tenant isolation and role restrictions. Confirm
  equivalent pre/post-refactor commands produce identical request hashes.
  The immediate test owner is
  `apps/api/test/connections/failure-notification-destinations.test.ts:31–263`:
  replace its HTTP fixture only for direct use-case tests; keep HTTP fixtures
  for controller parsing tests. Preserve the composed append-route regression
  in `apps/api/test/connections/http-stack.test.ts:363–381`.

#### MC-04 — Give retention capabilities clearer internal ownership (design proposal)

- **Exact targets:** `packages/database/src/lifecycle/retention.ts` exposes
  `RetentionDatabase` at `:110–135`; `createRetentionDatabase` at `:230–604`
  combines dry-run claim/page/process, batch creation, readiness, replica-lag
  observation, operator reruns, transient reaping and enforcement scheduling.
  `createRetentionEnforcementCoordinator` starts at `:618` in the same file.
  `apps/retention/src/maintenance-loops.ts:16–28` receives the broad database
  alongside separate enforcement/artifact/preview/purge coordinators.
- **Actual friction:** independently changing readiness/replica-lag logic or
  operator rerun handling requires navigating the same factory as dry-run
  processing and scheduler policy. File length alone is not the finding.
- **Proposed grouping:** keep dry-run claim/page/process and batch creation
  together; group readiness and replica-lag observations as maintenance health;
  isolate operator rerun dispatch; keep enforcement scheduling with its bounded
  scan policy. Keep transient reaping delegated to its existing implementation.
  Move the existing enforcement coordinator as one coherent unit if that
  clarifies ownership; do not break a page's claim/prepare/complete sequence
  into independently callable fragments. Suggested filenames are not a
  required architecture—choose after mapping the actual callers.
- **Selected design decision (recorded before implementation):** keep the public
  `RetentionDatabase` interface and `createRetentionDatabase` composition seam
  unchanged. That composer will acquire and close the single pool lease, then
  lend the pool and parsed options to four private capabilities: dry-run/batch
  work (`claimDryRuns`, `executeDryRunPage`, `processNext`, `startDryRun`,
  `startEnforcement`), maintenance health (`checkReadiness`,
  `recordRegionalReplicaLag`), operator recovery (`processOperatorRerun`), and
  enforcement scheduling (`scheduleEnforcement`). Transient-data reaping stays
  delegated to its existing module. `apps/retention/src/run.ts` is the health
  caller; `maintenance-loops.ts` consumes the latter three loop capabilities
  plus dry-run `processNext`; database integration tests additionally exercise
  the lower-level dry-run/batch methods. The extraction therefore removes SQL,
  validation, and mapping knowledge from the composer without exposing new
  public methods, creating extra pools/close owners, or splitting any
  claim/page/complete sequence.
- **Implementation constraints:** composition acquires/owns the pool lease once
  and lends it to internal capabilities. Do not create one pool per extracted
  file, duplicate `close`, change maintenance role, or replace explicit SQL
  fencing with generic repository calls. Preserve advisory-lock serialization
  with legal holds, timeout/abort handling, stale-lease outcomes, bounded batch
  limits, regional control-ledger authority and external-I/O ordering. Keep
  public exports compatible unless a deliberate caller migration is agreed.
- **Tests/closure:** `retention-scheduling.integration.test.ts`,
  `retention-operator.integration.test.ts`, `retention-legal-hold.integration.test.ts`,
  `retention-transaction.test.ts`,
  `retention-transaction-cancellation.integration.test.ts` and the artifact/
  purge retention suites under `packages/database/test` retain their real
  transaction tests. Retention-app loop tests must still demonstrate bounded
  polling/backoff and shutdown. Before implementation, record the chosen
  capability/caller map and what leaves the large factory. Close only when
  those changes reduce caller knowledge while preserving pool ownership and
  all durable invariants; a file split with unchanged broad coupling is not
  sufficient. No schema migration or new ADR is required merely to move code.

**Completed 2026-09-09:** `createRetentionDatabase` is now a small composition
owner for one maintenance pool lease and one `close`. It combines four private
capabilities in `retention-database-capabilities.ts` (dry-run/batch work,
maintenance health, operator recovery, and enforcement scheduling), with
shared parsing/query mapping in `retention-support.ts` and public shapes in the
leaf-neutral `retention-contracts.ts`. Transient reaping remains delegated and
the enforcement coordinator remains cohesive. Database build and all 264 unit
tests pass; seven scheduling/operator/legal-hold/cancellation/artifact/purge
integration files pass with 19 tests.

#### MC-05 — Remove implementation-root imports from shared type contracts (cleanup)

- **Exact edges:** `packages/database/src/authoring/workflow-authoring.ts:23–24`
  imports its read/draft stores; `workflow-authoring-reads.ts:11–19` and
  `workflow-authoring-drafts.ts:24–31` import their types back from that root.
  `packages/database/src/tenant-access/identity-workspace.ts:24–30` imports
  row/session implementations; `identity-workspace-rows.ts:4–10` and
  `identity-workspace-session-store.ts:7–11` import records/ports from the root.
- **Problem:** erased type back-edges make foundational contracts appear owned
  by the implementation assembler. This is navigation/ownership friction,
  **not** an emitted runtime cycle or proven initialization failure.
- **Change:** read existing record types directly from
  `authoring/workflow-authoring-records.ts`; put shared input/result/port types
  in a leaf-neutral authoring contract module, reusing
  `workflow-authoring-types.ts` if it remains cohesive. Put identity records,
  input types and shared port vocabulary in a leaf-neutral identity contract
  module. Both assembler and child stores import that contract. Preserve
  existing public type re-exports; do not create a catch-all package-wide
  `types.ts` or duplicate definitions across children. Include other child
  imports of these same roots in the migration, not just the four examples.
- **Apply the same bounded correction to the other verified back-edges:**
  `execution/dispatcher-rows.ts:3` imports `LeasedOutboxEvent` from its assembler
  `execution/dispatcher.ts`; `execution/failure-notification-completion-store.ts:10`
  and `failure-notification-destination-store.ts:9–14` import shared contracts
  from `execution/failure-notifications.ts`; `operator/operator-command-runtime.ts:6–9`
  imports `GenericOperatorCommandResult`/`OperatorCommandDatabaseOptions` from
  `operator/operator-commands.ts`. All paths are under `packages/database/src`.
  Move only shared contracts to a cohesive leaf in each feature, not a universal
  contract registry. Also change
  `tenant-access/oidc-login-transactions.ts:10` to import `IdentityConflictError`
  directly from the existing `identity-workspace-errors.ts`; that is a runtime
  import through a re-export, unlike the erased type edges.
- **Tests/closure:** verify no child needs its assembler solely for a type,
  no replacement leaf imports that assembler, public declarations remain
  compatible, and typecheck/build/architecture checks pass. Keep
  `workflow-authoring.test.ts`, authoring atomicity/coordination/publication
  integration suites and identity/session integration/cancellation tests.
  Do not rewrite behavior tests around moved private filenames.
- **Connection clarification:** `connections/connection-persistence.ts`
  already provides management/test/resolution `Pick`s (`:318–357`) and shares
  validation, mapping and transaction vocabulary with focused implementation
  files. Do **not** count its broad umbrella contract or line count as an
  independently confirmed missing-role-separation defect. Further splitting
  its shared codecs/helpers needs demonstrated caller friction; retain the
  current role-specific factories and single transaction authority. The
  earlier broad recommendation is bounded by this clarification.

**Completed 2026-09-09:** authoring, identity, dispatcher,
failure-notification, and operator-runtime shared shapes now live in cohesive
feature-local contract leaves, while assembler roots preserve their public
re-exports. Authoring children read record shapes directly from the existing
record leaf, and OIDC login imports `IdentityConflictError` directly from its
error owner. No replacement contract leaf imports its assembler. Database
typecheck/build and 264 unit tests pass; eight authoring/identity integration
files pass with 52 tests.

#### TQ-01 — Replace the core-node file-layout assertion (cleanup)

- **Exact target:** `packages/nodes-core/test/package-contract.test.ts:44–63`,
  test `keeps each core node behind definition, validation, and executor modules`.
  It loops over twelve hard-coded node directories and requires nonempty
  `definition.ts`, `executor.ts`, and `validation.ts` files in each.
- **Problem:** a behavior-preserving rename/merge fails the test, while three
  files containing incorrect implementations can satisfy it. The hard-coded
  list is another inventory to maintain beside the actual registry.
- **Change:** remove this layout-only assertion after mapping its intended
  responsibility guarantees to the existing public-registry tests. Where a
  guarantee is missing, exercise the registered definition's validation and
  executor through the supported registry. Do not merely replace the filename
  list with a directory snapshot. Do not derive independently pinned historical
  release expectations from the same live registry being tested.
- **Preserve:** browser/server export conditions, compatibility fingerprints,
  immutable version behavior, invalid-input handling and dispatch-marker tests.
- **Closure:** a private file rename with unchanged exports/behavior passes;
  removing a supported registration or breaking a required executor/validation
  behavior still fails an independent contract test. Run the nodes-core tests,
  build/typecheck and architecture checks. Record which stronger assertion
  replaces each claimed guarantee before deleting the old test.

#### TQ-02 — Replace partial source regexes with browser-entry protection (cleanup)

- **Exact targets:** `packages/node-sdk/test/package-contract.test.ts:37–50`
  reads only `src/index.ts` and `src/release.ts`, despite its “transitive source
  imports” title. `packages/nodes-core/test/package-contract.test.ts:34–42`
  scans only `src/index.ts`. The server-source regexes at SDK `:52–64` and
  core `:65–76` likewise do not inspect implementation dependencies.
- **Problem:** an intermediary module can import a Node builtin/server module
  without appearing in those inspected strings. Conversely a forbidden word
  in a comment can fail a regex without adding a dependency.
- **Change:** provide one reusable browser-entry dependency check for the
  SDK default/release exports and core default export. Resolve runtime imports
  and re-exports through local modules and workspace export conditions; cover
  literal dynamic imports or explicitly report them as unsupported instead of
  silently certifying them. Reject reachable Node builtins and server-only
  exports. A browser-target build with a verifiable dependency graph is also
  acceptable. Keep type-only imports separate from executable imports.
- **Existing gate limit:** `infrastructure/validate-module-imports.mjs:35–111`
  checks static relative runtime cycles and cross-package relative imports;
  it is not already a browser-reachability checker. Reuse its parser concepts
  where helpful, but do not delete the package tests merely because
  `architecture:check` passes.
- **Tests/closure:** add small fixtures for a two-hop forbidden import, a
  re-export, a legal type-only import, a comment containing `node:`, and browser
  versus server export resolution. The two-hop runtime violation must fail,
  and the safe cases must pass. Keep exact package export assertions and the
  server-only guard-order assertion unless a replacement actually proves that
  ordering guarantee. Remove only regex checks subsumed by the new protection.

#### TQ-03 — Measure the API orchestration implicated by this review (assurance)

**Selected measurement disposition:** retain the original near-100% API
critical-file cohort unchanged and add a separately named API orchestration
cohort for `application-error-mappers.ts`, `connection-testing.ts`,
`workflow-runs/use-cases.ts` and `sse-authorization-lifetime.ts`. The direct
`identity/oidc.ts`, identity/workspace and authoring use-case suites remain the
behavioral seams for those modules; `app.ts` remains covered by the composed
Nest/Fastify bootstrap suite. They are intentionally not folded into this first
orchestration denominator because doing so would mix independently actionable
coverage debt into the WB-01–06 closure. `main.ts` remains excluded from unit
coverage because its process exit/signal behavior requires compiled
child-process evidence. These are explicit evidence dispositions, not claims
that the excluded production files have percentage coverage.

- **Exact target:** `apps/api/vitest.coverage.config.ts:11–16` includes selected
  identity, HTTP, rate-limit and workspace-policy files, not all API source.
  API-wide unit test execution does not make excluded files appear in coverage.
- **First concrete additions:** `src/workflow-runs/use-cases.ts` and
  `src/workflow-runs/sse-authorization-lifetime.ts` for stream authorization,
  `src/connections/connection-testing.ts` for dispatch cancellation, and
  `src/application-error-mappers.ts` for composed error mapping. Add these
  alongside WB-01–04/WB-06 regression work, not after declaring those fixes done.
- **Existing test owners:** `apps/api/test/workflow-runs/use-cases.test.ts`,
  `test/workflow-runs/sse-transport.test.ts`,
  `test/connections/use-cases.test.ts`, `test/api-bootstrap.test.ts`, and
  `test/platform/http/problem-details.filter.test.ts`.
- **Further explicit disposition:** record the measurement/test seam for
  `src/identity/oidc.ts`, `src/identity-workspace/use-cases.ts`,
  `src/workflow-authoring/use-cases.ts`, `src/app.ts`, and `src/main.ts`.
  Reuse `test/identity/oidc.test.ts`, identity/authoring use-case suites and
  bootstrap tests; process entrypoints may need child-process evidence rather
  than a fake unit percentage. An intentional exclusion needs a named reason
  and alternative evidence, not silence.
- **Closure:** changed include inventories are asserted, new high-risk files
  occur in the report, and their safety branches have behavioral regressions
  including the WB combinations. Keep existing critical-file protections;
  if a broader denominator requires separate cohorts, retain the old cohort
  and establish the new one explicitly rather than lowering the old gate.
  Passing coverage is additional evidence, not a substitute for those cases.

#### TQ-04 — Measure worker readiness and lifecycle behavior (assurance)

- **Exact target:** `apps/worker/vitest.coverage.config.ts:21–23` includes only
  `failure-notification-delivery`, `node-attempt-handler`,
  `node-runtime-capabilities`, and `preview-attempt-runtime`.
- **First concrete additions:** `src/runtime/worker-readiness-monitor.ts`,
  `src/runtime/worker-readiness.ts` and
  `src/runtime/worker-process-shutdown.ts`. Make the monitor's in-flight check
  and stopping state observable through its lifecycle interface, not private
  variable assertions.
- **Test work:** add a focused readiness-monitor lifecycle suite for deferred
  success, deferred failure and shutdown during marker writing (WB-05), using
  isolated temporary paths or an internal marker adapter. Preserve
  `test/worker-bootstrap.test.ts` and
  `test/worker-process-lifecycle.test.ts` as composition/process evidence.
- **Closure:** no late completion recreates readiness after final shutdown;
  checks/timers are settled or stopped; repeated shutdown is safe; resources
  close in the established order. New files appear in a measured cohort, with
  existing execution thresholds retained. Child-process behavior is reported
  separately where the unit coverage collector cannot observe it.

#### TQ-05 — Make risk classifications and integration evidence unambiguous (assurance)

**Selected policy decision (recorded before tooling implementation):**
lifecycle-command, API (including the separate orchestration measurement),
worker and database are strict cohorts: every uncovered branch must have a
durable review. Existing unreviewed debt in
artifact-store (8), contracts (1), integrations (3) and workflow-engine (11)
is retained as an explicit ceiling, not accepted as reviewed; the report
rejects any increase. The new, separately measured API orchestration cohort
retains the original near-100% API gate and establishes an honest independent
non-regression floor without weakening that gate; its remaining uncovered
branches must still be covered or durably classified.
Source-linked named integration tests are `referenced-only`. They become
`executed` only when a matching passing, non-skipped result is supplied for the
same test identity and reviewed source revision. This staged policy prevents
new silent debt and avoids falsely relabeling historical gaps.

- **Exact targets:** `infrastructure/report-risk-coverage.mjs:394–400` verifies
  that an integration test name occurs in its source; `:411–415` enforces the
  exact file inventory/no-unreviewed rule only for `lifecycle-command`.
  `infrastructure/risk-coverage-reviews.json` stores the classifications.
  Cohort test-health reports are consumed elsewhere; the specific limitation
  is that a referenced integration case is not proven executed by source text.
- **Change:** label source-linked integration evidence as a reference until
  a matching successful execution artifact is supplied. If the report claims
  executed integration evidence, match test identity and result from the
  relevant run, reject failed/skipped/missing cases, and bind evidence to the
  reviewed source revision. Offline/unit-only runs should say “not executed
  in this run,” not masquerade as integration-qualified runs.
- **Policy decision:** document which cohorts must reject new/unreviewed
  uncovered branches. Preserve the lifecycle rule; choose an explicit staged
  policy for other high-risk cohorts rather than silently declaring all 23
  existing unreviewed branches acceptable or relabeling them defensive.
- **Database distinction:** `packages/database/vitest.integration-coverage.config.ts`
  already includes `src/**/*.ts`; `database:coverage:merge` combines it with
  the narrow unit cohort. Preserve that real-service evidence. This item does
  not request a duplicate all-database unit suite or claim database source is
  absent from integration coverage.
- **Tests/closure:** extend `infrastructure/report-risk-coverage.test.mjs`
  with present-but-skipped, failed, missing, stale-revision and passing
  integration evidence, plus policy tests for permitted versus prohibited
  unreviewed branches. Output must distinguish executed, reviewed-uncovered,
  referenced-only and unreviewed states. Document the cohort policy and do not
  mark externally unavailable tests passed to close this item.

#### MH-01 — Constrain exercise paths to the configured origin (hardening)

- **Exact target:** `infrastructure/exercises/run-http-exercise.mjs:280–293`,
  `loadInputs`: `startsWith('/')` accepts `//another-host/path`, then
  `new URL(path, base)` changes origin. Authentication headers are assembled
  by `requestAuthenticationHeaders` at `:247–267`.
- **Change:** validate the target before loading/using authentication: reject
  network-path references and backslashes and require resolved origin equality
  with the configured base. Keep legitimate absolute paths, query strings and
  supported base protocols. Extract a pure target resolver only if that makes
  the input contract directly testable; do not add another HTTP client layer.
- **Tests/closure:** extend `infrastructure/exercises/run-http-exercise.test.mjs`
  with ordinary paths, same-origin queries, `//host`, `///host`, backslashes
  and non-path input. Invalid targets fail before authenticated network I/O.
  Both inputs are operator-controlled today; classify this as prevention of
  configuration mistakes, not an external credential-theft vulnerability.

### Per-area coding assessment

These are current-baseline judgments, not inherited scores from the historical
sections. Naming, conditions/constants, readability, responsibility boundaries,
runtime/data safety, and test value are considered together below. A clear
module can still contain a consequential defect; absence of a finding is not
proof of defect-free behavior. Numerical scores follow this assessment and the
completed inspection ledger.

| Area | What is working and should remain | Specific friction or next improvement |
| --- | --- | --- |
| API | Feature ownership is recognizable; request-bound authorization capabilities, real routing tests, explicit persistence adapters and safe response shapes provide useful seams. Constants and guard names generally express policy rather than incidental mechanics | Error normalization has competing fallback owners (WB-01–03). Signal/observer lifetimes are incomplete at composed operations (WB-04, WB-06). Remove unused DI registrations, narrow oversized use-case ports, and separate destination commands from HTTP request parsing. These changes should reduce alternate paths and test scaffolding |
| Worker | Claim, execute, dispatch marking, completion and coordinator persistence are separate responsibilities. Explicit leases and ambiguity classifications are necessary safety complexity; deferred-promise and transport-loss tests are valuable | Readiness lacks a terminal lifecycle boundary (WB-05). Keep constructor/cleanup ownership visible when assembling attempt capabilities; do not turn each small callback into another framework. Selected coverage misses lifecycle code, so execution-file coverage is not worker-wide assurance |
| Lifecycle command | Command parsing, execution and side-effect ports separate operator intent from destructive work. Confirmation, deadline, replay and cleanup tests protect observable safety | Preserve bounded cleanup and cancellation behavior at the public command seam. The specially enforced risk-coverage cohort is useful but must not be generalized to claim all other cohorts have no unreviewed branches |
| Operator command | Small command surface with explicit compatibility and control operations; argument validation and guarded execution are appropriate | Keep operator authorization and target identity explicit. Do not add a generic command abstraction solely to deduplicate small parsing branches; distinguish local command checks from live operational qualification |
| Recovery | Recovery evidence and orchestration are kept separate from ordinary execution. Dedicated identities and fail-closed checks fit the risk | Regional/control-storage configuration must be judged at the composition owner with artifact storage (WB-08), not independently per parser. Local tests do not qualify real regional failover |
| Retention | The app delegates durable retention authority to database/control-ledger owners instead of duplicating deletion policy. Bounded batches and cancellation are meaningful | Preserve thin composition here; capability deepening belongs in the large database retention owner. Avoid duplicating retry or cleanup policy in both app and database layers |
| Artifact store | Explicit object identity, checksums, capacity limits, upload finalization and control-ledger roles have useful contracts. Fake-adapter tests and local integration cover different failure surfaces | Validate the complete artifact/control location matrix (WB-08). Keep the three unexecuted AWS-only tests visible; local object-store behavior is not evidence for AWS retention/permissions guarantees |
| Contracts | Generated outputs, route catalogs and deterministic schemas make the public surface inspectable. Exact export and regeneration checks are useful | Repeated handwritten header definitions drift from runtime (WB-09). Share grammar at the transport seam and retain independent acceptance/rejection cases; generated equality alone cannot detect incorrect source schemas |
| Database | Tenant transactions, RLS/grants, explicit fences, immutable versions, inbox/outbox identity and real PostgreSQL integration provide strong protection. Coordinator planning/validation/commit separation is worth preserving | Notification context assumes every terminal failure belongs to a node (WB-10). Deepen independently consumed retention/connection capabilities without hiding SQL lock order or splitting atomic operations. Keep schema and migration invariants visible rather than introducing generic repositories |
| Integrations | Provider-specific adapters sit behind bounded runtime capabilities; dispatch evidence and safe error classification are explicit. Security checks at distinct entry points are not redundant | Cancellation must be forwarded by callers as well as supported by clients (WB-06 is in the API caller). Preserve ambiguity semantics and independently exercise pre-/post-dispatch failure paths; provider mocks do not certify actual provider behavior |
| Node catalog | Small projection layer derives browser-safe catalog information from registered definitions; historical release tests protect observable compatibility | Keep the single registration/projection source and ordering contracts. Do not split projection helpers merely to reduce file length; improve tests only where they assert layout instead of catalog behavior |
| Node SDK | Registry, release identity, execution and capability contracts are separate and deliberately explicit. Hostile-value and immutable-release tests provide real value | The purported transitive-import source test does not traverse the whole graph. Replace that assurance with a graph/build check; preserve independently pinned fingerprints rather than deriving expected values from the implementation under test |
| Core nodes | Shared registration and consistent node contracts make many files navigable. Immutable behavior versions, golden compatibility values, executor matrices and dispatch-marker tests are intentional protection | The three-filenames-per-node test obstructs cohesive refactoring without protecting runtime behavior. Replace layout/source-regex checks with export/import-graph or executable contract checks. Repeated immutable version code is not automatically safe to deduplicate |
| Observability | Structured safe fields, bounded labels, redaction and explicit shutdown keep diagnostics separate from domain work. Tests cover sanitization and lifecycle behaviors | Diagnostic failure containment must hold at consumers too (WB-03). Avoid treating arbitrary hypothetical tracer callback behavior as a production defect without evidence. Preserve meaningful label bounds rather than adding generalized serialization machinery |
| Queue | Durable message identities, schema checks, readiness and transport cleanup have clear ownership. Redis-loss/recovery integration adds evidence not supplied by mocks | Keep queue delivery distinct from database execution authority. Do not duplicate durable retry decisions in transport wrappers or inflate coverage with filename checks |
| Rate limit | Compact policy/store separation, bounded dimensions and explicit unavailable behavior are proportionate to the problem | Keep policy constants centralized and failure-mode tests behavioral. Runtime validation of impossible internal typed states is hardening, not a demonstrated production bug; avoid multiplying adapters for this small module |
| Workflow engine | Pure transitions, explicit control facts, scoped invocations and durable plans make orchestration testable. Branch/loop/retry/control matrices protect meaningful combinatorial behavior | Test valid engine outcomes across persistence consumers, especially node-free deadlines with notifications (WB-10). Keep pure planning separate from database mechanics and avoid broad rewrites of intentional state-machine complexity |
| Workflow model | Central graph, executable, checkpoint and notification schemas expose domain invariants and compatibility versions | Notification context needs a truthful run-level failure variant (WB-10). This is a domain correction, not a permissive optional node field everywhere. Preserve canonicalization, bounded graph validation and independent compatibility fixtures |
| Root, CI and infrastructure | Dependency, complexity, duplication, contract and image gates make policy executable. Authored scripts/configs were inspected; syntax checks and structural JSON/YAML/lockfile validation add evidence | Image-pin parsing misses CI's actual YAML override shape (WB-07). Historical ledgers/baselines are revision-bound evidence, not proof of current full inspection. Add negative mutations for advertised gates and avoid raising baselines to hide regressions |
| Documentation | The plan, context and ADRs provide explicit sources of authority; revision-pinned historical reports can explain previous decisions | Use this current section as the assessment entry point. Preserve historical labels and distinguish implemented guarantees from local tests and external qualification. Do not update old pinned counts to pretend they describe the new tree, or delete linked history without agreement |

An additional non-blocking exercise-runner hardening opportunity is to enforce
that `new URL(path, base).origin === base.origin` and reject network-path inputs
in `infrastructure/exercises/run-http-exercise.mjs`. Its current leading-slash
check accepts `//another-host/path`. The path and base are both supplied by the
operator's environment, so this is not presented as an untrusted remote-input
vulnerability or a deployed credential leak. A same-origin assertion would
make the advertised path contract safer against configuration mistakes.

### Refreshed scores

Scores are qualitative engineering judgments, not measured coverage or defect
probabilities. Use 9 for a particularly cohesive area with no material issue
identified, 8 for strong code with bounded improvement opportunities, 7 for
good foundations needing targeted corrections, and 6 for a criterion with
several consequential gaps. No area receives 10 from a finite review. Scores
are rounded, and the overall 7/10 is risk-weighted rather than an average of
package sizes or test counts. The preceding area notes supply their rationale.

“Names” includes file/folder organization and terminology; “Flow” includes
conditions, guards, constants and readability; “Design” includes responsibility
separation, interfaces and duplication; “Safety” includes runtime/error/data,
security, concurrency and resource behavior; “Tests” includes fault detection,
realism, brittleness and honest coverage scope.

| Area | Names | Flow | Design | Safety | Tests | Overall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| API | 8 | 7 | 7 | 6 | 7 | 7 |
| Worker | 8 | 8 | 8 | 7 | 8 | 8 |
| Lifecycle command | 8 | 8 | 8 | 8 | 8 | 8 |
| Operator command | 8 | 8 | 8 | 8 | 8 | 8 |
| Recovery | 8 | 8 | 8 | 8 | 8 | 8 |
| Retention | 8 | 8 | 8 | 8 | 8 | 8 |
| Artifact store | 8 | 8 | 8 | 7 | 8 | 8 |
| Contracts | 8 | 8 | 8 | 7 | 7 | 7 |
| Database | 8 | 7 | 7 | 7 | 8 | 7 |
| Integrations | 8 | 8 | 8 | 8 | 8 | 8 |
| Node catalog | 9 | 9 | 9 | 9 | 8 | 9 |
| Node SDK | 9 | 8 | 9 | 8 | 8 | 8 |
| Core nodes | 9 | 8 | 8 | 8 | 8 | 8 |
| Observability | 8 | 8 | 8 | 8 | 8 | 8 |
| Queue | 8 | 8 | 8 | 8 | 8 | 8 |
| Rate limit | 8 | 8 | 8 | 8 | 8 | 8 |
| Workflow engine | 8 | 8 | 9 | 8 | 8 | 8 |
| Workflow model | 9 | 8 | 8 | 7 | 8 | 8 |
| Root, CI and infrastructure | 8 | 7 | 8 | 7 | 7 | 7 |

Documentation is assessed separately at **8/10 for clarity and authority**:
current contracts and ADRs are useful, but extensive historical material needs
clear revision boundaries. That is not a runtime/test score or a renewed
production-readiness qualification.

### Recommended follow-up order

1. Correct the run-level notification model and cross-seam timeout regression
   (WB-10). A legitimate engine transition must not become uncommittable because
   optional notification configuration is enabled.
2. Repair operation ownership at connection dispatch, SSE waits and worker
   shutdown (WB-06, WB-04, WB-05). Keep each change paired with a deferred or
   cancellation regression at the real operation boundary.
3. Consolidate safe error-response normalization (WB-01–03). Resolve precedence,
   catalog membership and sink isolation together, with composed-app tests.
4. Close configuration/contract assurance gaps (WB-08, WB-07, WB-09), using
   complete collision matrices and negative grammar/configuration cases.
5. Remove unused DI paths and layout-bound tests, then narrow ports where that
   measurably removes irrelevant dependencies or stubs. Evaluate larger
   database capability changes separately; do not bundle them into bug fixes.

For non-bug work, MC-01/MC-02/MC-03 and MC-05 are bounded cleanup candidates;
TQ-01/TQ-02 replace weak tests, not safety contracts. Pair TQ-03/TQ-04 with the
relevant bug fixes. Settle TQ-05's evidence policy and MC-04's capability design
before implementation. MH-01 is independent optional hardening.

Closeout checklist:

- [x] MC-01: duplicate/unused DI registrations removed; composed routes verified.
- [x] MC-02: listed use-case ports narrowed; irrelevant test scaffolding removed.
- [x] MC-03: typed destination commands replace HTTP-shaped application input.
- [x] MC-04: retention design selected, then cohesive extraction verified.
- [x] MC-05: shared types no longer require child-to-assembler imports.
- [x] TQ-01: layout test replaced by documented executable guarantees.
- [x] TQ-02: transitive browser dependency protection passes negative fixtures.
- [x] TQ-03: API measurement expanded/dispositions documented; regressions pass.
- [x] TQ-04: readiness/lifecycle measurement and shutdown regressions pass.
- [x] TQ-05: evidence states and cohort enforcement policy made explicit/tested.
- [x] MH-01: same-origin exercise target contract verified before authenticated I/O.

For each completed item record the changed symbols, removed/replaced path,
checks and results, revision, and any residual limitation next to its ID. An
accepted deferral must record its reason; it is not “fixed.” These checklist
items supplement WB-01–10 and do not close any of those bugs implicitly.

The sequence above records the pre-implementation recommendation. The user
subsequently authorized implementation of all listed items. No commit, push or
deployment is part of this closeout.

### Current implementation closeout — 2026-09-09

All changes below are present only in the uncommitted working tree. “Passed”
means the named local check completed successfully; it does not qualify live
AWS, provider, regional-failover, or production behavior.

| Item | Resolution and concrete evidence |
| --- | --- |
| WB-01 | Error normalization now preserves Nest `HttpException` semantics before feature mapping, and feature mappers decline unknown failures instead of manufacturing a terminal fallback. Composed bootstrap/filter regressions cover unknown nested routes plus explicit 400/401/403/404/503 responses with the real mapper set. |
| WB-02 | Application errors require an own catalog property. `constructor`, `toString`, `__proto__`, ordinary unknown values, and optional-field sanitization all pass through the safe generic problem path. |
| WB-03 | The complete logger invocation is isolated from response emission for both synchronous throws and rejected promises; the original safe problem is sent exactly once. |
| WB-04 | SSE authorization lifetime now owns removable wait subscriptions and coalesces refresh work instead of adding a permanent reaction per frame. Long-stream observer bounds, pre-revocation, refresh coalescing, stalled lookup, expiry, disconnect, backpressure, and stop-during-refresh regressions pass. |
| WB-05 | `WorkerReadinessMonitor` owns one in-flight check, has terminal stopping/stopped states, awaits completion before final marker removal, and refuses new scheduling/check work during shutdown. Deferred success/failure, marker-write overlap, coalescing, repeated shutdown, and drain-during-probe regressions pass. |
| WB-06 | Connection test dispatch retains and checks the request signal across decryption and forwards it to HTTP, Slack, and email clients. Pre-dispatch abort prevents provider I/O; in-flight abort reaches the client; completed replay still skips decryption and dispatch. |
| WB-07 | The image-pin validator recognizes both YAML environment mappings and dotenv assignments. Negative mutable-tag mutations in both representations and the repository image check pass. |
| WB-08 | Control-ledger configuration validates the complete primary/recovery artifact and ledger bucket collision matrix while retaining valid regional endpoints and credentials. Matrix regressions pass. |
| WB-09 | Transport-owned CSRF, idempotency, content-type, and related header schemas now drive both runtime parsing and OpenAPI generation. Grammar-edge parity tests and regenerated contract artifacts pass contract validation. |
| WB-10 | ADR 022 records a strict backward-compatible node/run primary-failure union. Node-free queued timeouts persist a truthful run-level context atomically and render run scope without inventing a node; replay, model, worker, database unit, and scheduling integration regressions pass. |
| MC-01 | Removed duplicate OIDC/session/user controller factories and unused connection/authoring persistence, encryption, telemetry, and catalog registrations, including dead latest-catalog plumbing. Module uniqueness and composed route tests preserve controller/guard resolution. |
| MC-02 | Identity/workspace, authoring, and workflow-run use cases now depend on method-level `Pick` contracts. The unused API `getVersion` aggregate member and irrelevant focused-test stubs were removed while real adapters and composition ownership remain unchanged. |
| MC-03 | Destination controllers now parse authentication, route metadata, and idempotency headers into typed application commands; direct use cases no longer manufacture HTTP requests. All seven operations, canonical request hashes, invalid/missing/duplicate headers, unauthenticated access, and hidden-workspace behavior are covered. |
| MC-04 | The recorded design was implemented: `createRetentionDatabase` owns one pool lease/close and composes cohesive dry-run/batch, health, operator-recovery, and enforcement-scheduling capabilities. Database build/unit checks and seven relevant integration files (19 tests) pass. |
| MC-05 | Authoring, identity, dispatcher, failure-notification, and operator contracts moved to feature-local leaves; child modules no longer import assembler roots solely for types, public re-exports remain compatible, and OIDC imports its error directly. Architecture, database build/typecheck/unit checks, and eight authoring/identity integration files (52 tests) pass. |
| TQ-01 | The core-node private filename assertion was replaced with a pinned public registration inventory backed by existing schema/executor behavior suites. |
| TQ-02 | A reusable TypeScript-AST traversal now rejects transitive Node built-ins, server-only modules, unavailable browser exports, and non-literal dynamic imports. Safe, direct, and two-hop negative fixtures pass for browser entrypoints. |
| TQ-03 | The original API critical cohort remains unchanged at 100% across statements, branches, functions, and lines. A separate asserted orchestration cohort measures the four review-target files at 96.47% statements, 94.04% branches, 96.82% functions, and 97.31% lines; 582 tests pass and every remaining branch has a durable review. Identity/OIDC/authoring use cases retain their named direct suites, `app.ts` retains composed bootstrap evidence, and `main.ts` retains child-process disposition rather than a fabricated unit percentage. |
| TQ-04 | Worker coverage now includes readiness monitor, readiness, and process-shutdown sources. The worker run passes 286 tests at 94.00% statements, 95.08% branches, 83.33% functions, and 94.41% lines; remaining selected-file branches are reviewed under the strict policy and child-process shutdown remains separately exercised. |
| TQ-05 | The risk report distinguishes `unreviewed`, `reviewed-uncovered`, `referenced-only`, and source-revision-bound `executed` evidence. Lifecycle, API, API orchestration, worker, and database cohorts are strict; the pre-existing artifact/contracts/integrations/workflow-engine debt ceilings remain 8/1/3/11. Thirteen policy regressions pass, and the current report records 468 reviewed plus 23 ceiling-bound unreviewed branches across 129 selected files and 5,449 coverable lines. |
| MH-01 | Exercise targets must resolve as absolute-path HTTP(S) URLs on the configured origin before authentication headers or network I/O. Ordinary/query paths pass; network paths, alternate origins, backslashes, and non-path inputs fail. |

| Combined closeout check | Result and limit |
| --- | --- |
| `pnpm check` | Passed end to end: formatting, documentation, runtime/project/import/dependency/schema gates, build, lint, complexity and duplication ratchets, generated contracts, all workspace typechecks, and 2,388 unit/component tests. |
| `pnpm test:coverage` | Passed end to end. The original API critical cohort remains 100%; API orchestration and worker results are recorded under TQ-03/TQ-04. The risk report enforces all strict cohorts and the four frozen debt ceilings. |
| `pnpm test:integration` | Exited successfully with all 408 PostgreSQL integration tests passing. The ordinary command did not enable artifact-store, queue, worker, or API service gates, so their 73 tests were reported as skipped rather than passed. The WB-10/MC-04/MC-05 focused database integration sets are included in the passing database run; live Redis/S3/provider qualification remains a recorded limit. |
| `pnpm deployment:check` | Passed runtime-closure typecheck, 29 deployment assertions, deterministic rendering, and digest-pin validation. |
| `pnpm images:check` / `pnpm exercise:check` | Passed seven image-pin and seven exercise-runner assertions, including the new negative YAML and same-origin cases. |

A later source-bound risk report generated at `2026-09-09T12:11:25.558Z`
records 468 reviewed and 22 unreviewed branches (artifact store 8, contracts 1,
integrations 2, workflow engine 11). The 23 above remains the preceding closeout
observation and equals the configured ceiling total; it is not silently
rewritten as if it came from the later run. No coverage threshold or debt
ceiling changed during this reconciliation.

The baseline score and per-area narrative above remain pinned review evidence
rather than being retroactively edited into a post-remediation audit.

## Historical assessment — 2026-09-08

Date: 2026-09-08. Source revision: `2206d6748c0c728ff9bf61f4ea06e64fb9eb0b1a`.
Branch: `feat/low-value-code-cleanup`, upstream
`origin/feat/low-value-code-cleanup`.

## Status and scope

**Expanded coding-quality assessment:** the per-part section below separately
evaluates file/folder naming and consistency; conditions, guards and constants;
readability and complexity; responsibility separation, interfaces and duplication;
runtime/error/data safety; and test quality. “Reviewed” in the inventory is not an
unconditional quality pass. Explicit change recommendations, retained complexity,
and verification limits accompany the individual assessments. The original
read-only findings are retained below as the reproduction baseline; the
implementation resolution in this section records their current status.

Production-source review complete across all 12 packages and 6 apps. This report
records the six confirmed findings from the preceding read-only audit and a
fresh package-by-package review followed by an app-by-app review. Manual test
inspection is not exhaustive for the database package; its limit is recorded
below, separately from passing test executions. Existing `AGENTS.md` edits belong
to the user and were not changed by this work. The user subsequently authorized
implementation of all F01–F09 and CQ01–CQ05 items. No commit, push, deployment,
or paused merge follow-up is included.

The review uses Node runtime, async, resource ownership, error handling, streams,
logging, configuration, and testing guidance; PostgreSQL guidance for schema,
transactions, concurrency, RLS, and queries; and NestJS guidance for modules,
DI, controllers, guards, and lifecycle. Existing project contracts override
generic skill preferences, including buildless TypeScript, vendor choices,
validation libraries, and module patterns.

The previous `code-review` skill run reviewed the fixed-point `main...HEAD` diff
along Standards and Spec axes. This new whole-repository pass is not presented
as another fixed-point review. Its coding-smell checklist covers Mysterious Name,
Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches,
Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains,
Middle Man, and Refused Bequest. These are judgment-based heuristics, not automatic
violations or reasons to reopen settled architecture. Tool-enforced style issues
are not duplicated as manual findings.

“Reviewed” records source inspection and the named checks, not proof of absence
of defects. Unit tests do not establish production concurrency, external network
policy, or live AWS behavior. Test executions from the preceding audit are
distinguished from fresh executions below.

## Finding index

All nine confirmed findings are resolved in the working tree: **2 P1, 6 P2,
1 P3**. The first six were carried forward; F07–F09 were additional findings
from this pass. Priorities remain as historical remediation priorities.

| ID | Priority | Issue | Primary ownership |
| --- | --- | --- | --- |
| F01 | P1 | Hold acknowledgment races physical deletion | Database lifecycle/retention |
| F02 | P1 | For Each starts with incompatible checkpoint V1 | API and worker initialization |
| F03 | P2 | Finalized uploads retain pending expiration | Database artifacts/retention |
| F04 | P2 | Late replica PUT recreates an orphan after cleanup | API, artifact store, retention |
| F05 | P2 | API provider egress is absent from deployment contract | API/deployment |
| F06 | P2 | Early API construction bypasses cleanup | API composition |
| F07 | P3 | PUBLIC grants disappear from grant-test assertions | Database tests |
| F08 | P2 | Error.name skips log sanitization/bounds | Observability |
| F09 | P2 | Trigger OpenAPI omits required security/headers | Contracts/API |

## Implementation resolution

| Item | Resolution and fresh evidence |
| --- | --- |
| F01 | Workspace purge, run-artifact retention, preview-artifact retention, control-ledger projection and direct legal-hold projection share a workspace-keyed advisory lock. Disposable PostgreSQL tests prove hold acknowledgment waits for both run and preview artifact deletion and a projected hold prevents object-store calls. |
| F02 | API and worker production selectors choose checkpoint V2 for `core.foreach@1`; verified-executable and worker-factory regressions pass. |
| F03 | Finalization replaces the pending deadline with the standard 30-day user-upload deadline. Migration `0083` backfills existing available uploads to 30 days from finalization under their FORCE RLS workspace scope, and grants only `expires_at` update authority to artifact writer roles. |
| F04 | Finalization verifies replicas under the same workspace lifecycle lock used by expiry cleanup, without holding a transaction during object-store I/O. A gated PostgreSQL/store interleaving proves cleanup waits, expired finalization fails, late bytes are removed and capacity returns to baseline. Cancellation while queued for a pool client rejects promptly and releases any client delivered later without querying; cancellation during the advisory-lock query destroys the checked-out connection. Deterministic and live-PostgreSQL regressions prove both waits are safe, no session lock leaks, and destructive work does not execute. |
| F05 | The ECS external-platform contract declares API `provider-api` egress; all 29 deployment checks pass. |
| F06 | Every runtime-construction stage is inside one cleanup boundary, including synchronous `close()` failures. Cleanup failures are aggregated after the original startup error instead of replacing it. Bootstrap regressions cover later factory failure, readiness failure plus rejected teardown, and Redis URLs without a hostname. |
| F07 | The ACL query maps grantee OID zero to `PUBLIC` instead of inner-joining it away. A disposable-schema regression injects a PUBLIC grant and proves it remains observable. |
| F08 | Structured logging sanitizes and bounds `Error.name` like other untrusted text; redaction and 20,000-character regressions pass. |
| F09 | Schedule and webhook OpenAPI sources and generated artifacts declare cookie security, required management/ingress headers, typed success bodies and error responses. Generation parity and all 38 contract tests pass. |
| CQ01 | Connection testing and provider outcome mapping moved to `connection-testing.ts`, with shared serialization in feature-local support; public use-case exports and DI identity remain compatible. |
| CQ02 | The operator runner has table-driven coverage for all ten command variants plus null status, pre-abort, readiness/operation failures, cleanup timeout and multiple cleanup failures; 23 tests pass. |
| CQ03 | `RetentionScheduleResult.capacityLimited` owns the 25-row policy. Database integration covers full, partial and empty results; the app proves capacity-filled batches drain immediately. |
| CQ04 | Browser-safe platform definition registrations have one catalog-owned collection while server executor assembly remains separate. |
| CQ05 | Schedule and webhook authorization tokens live in feature-local `tokens.ts` modules with symbol identity and Nest wiring preserved. |

## Coverage ledger

Package production-source review preceded the app review. Remaining database
test inspection and app inspection then proceeded concurrently. Each row records
concrete areas, checks, and remaining gaps.

| Part | Status | Evidence / gaps |
| --- | --- | --- |
| `packages/artifact-store` | Reviewed | 15 production / 13 test-support files; streaming, replicas, conditional ledger writes and ownership; F04 crosses the caller/retention boundary |
| `packages/contracts` | Reviewed | 23 production / 8 test files plus generator and generated schemas; API guard/contract cross-check confirms F09 |
| `packages/database` | Reviewed; test inspection partial | 168 production TS files and 84 migrations; selected tests/support inspected, all 245 configured unit tests passed; F01/F03/F07 |
| `packages/integrations` | Reviewed | 32 production / 9 test files; provider requests, bounded responses, SSRF, credentials and cancellation; F05 is deployment integration |
| `packages/node-catalog` | Reviewed | 5 production / 5 test-support files; registry and definition resolution; no additional confirmed finding |
| `packages/node-sdk` | Reviewed | 10 production / 2 test files; bounded JSON, definitions, release and executor contracts; no additional confirmed finding |
| `packages/nodes-core` | Reviewed | 57 production / 7 test files; all core definitions, validation, executors and registration; F02 is app initialization, not a new core-node defect |
| `packages/observability` | Reviewed | 11 production / 11 test files; logging, telemetry sanitization, metrics, lifecycle and abortable delays; F08 |
| `packages/queue` | Reviewed | 12 production / 12 test-support files; Redis transport identity, job contracts, publisher/consumer ownership and shutdown |
| `packages/rate-limit` | Reviewed | 4 production / 3 test files; Redis configuration, atomic limiter behavior, key bounds and resource ownership |
| `packages/workflow-engine` | Reviewed | 48 production / 28 test-support files; compilation, checkpoint versions, scheduling, transitions, retries and scope; F02's engine rejection confirmed |
| `packages/workflow-model` | Reviewed | 22 production / 9 test files; graph and JSON boundaries, expression worker/evaluator, mappings and identity; no additional confirmed finding |
| `apps/api` | Reviewed | 138 production / 86 test-support files; controllers, guards, composition, request boundaries and tests; F02/F04/F05/F06/F09 |
| `apps/lifecycle-command` | Reviewed | 4 production / 6 test files plus compiled-process fixture; 25 tests passed |
| `apps/operator-command` | Reviewed | 3 production / 2 test files; 23 tests passed |
| `apps/recovery` | Reviewed | 3 production / 2 test files; 10 tests passed |
| `apps/retention` | Reviewed | 5 production / 3 test files; 12 tests passed; F01/F03/F04 are cross-package retention risks |
| `apps/worker` | Reviewed | 54 production / 73 test-support TS files plus process/JSON fixtures and 7 configuration files; execution, transport, supervision and shutdown; 278 tests passed; F02 |

## Original confirmed-finding detail

The descriptions below record the state that produced each finding. They are
superseded by the implementation-resolution table above. “Introduced” means
introduced by the preceding audit's pinned branch diff.

### F01 — P1: legal holds can complete while physical purge continues

Origin: pre-existing. Areas: database lifecycle, retention.

Evidence: `packages/database/src/lifecycle/workspace-purge.ts:400–429`,
`packages/database/migrations/0058_workspace_object_versions_purge.sql:87–112`
and `:144–160`, and
`packages/database/migrations/0044_retention_control_foundation.sql:316–398`.

The purge claim releases the workspace lock before external object-version
deletion. A legal hold can commit while deletion is in flight. The checkpoint
rechecks the hold only after bytes have been erased; rejection cannot undo that
destruction. This conflicts with ADR 013's legal-hold protection. The preceding
audit's in-memory reproduction returned `idle` despite deletion after a
simulated hold. That reproduction was not a live PostgreSQL/S3 concurrency test.

Fresh package-pass extension: individual artifact retention has the same gap.
`packages/database/src/lifecycle/run-artifact-retention.ts:143–164` commits
preparation before external deletion at `:191–200`; its next transaction starts
at `:224`. `app.complete_run_artifact_retention` in
`packages/database/migrations/0055_standard_retention_classes.sql:580–600`
rejects a changed control high-water or active hold only after deletion. The
existing hold test in
`packages/database/test/retention-artifacts.integration.test.ts:537` installs
the hold before retention starts, not during the destructive I/O. This is an
additional affected path under F01, not a seventh independent finding.

Correction direction: coordinate hold acknowledgment with in-flight destructive
work. Regression: interleave an actual hold with a gated object deletion and
assert byte preservation, not only checkpoint rejection.

### F02 — P1: For Each workflows receive an incompatible initial checkpoint

Origin: pre-existing. Areas: API admission, worker initialization, workflow engine.

Evidence: `apps/api/src/executions/initial-workflow-checkpoint.ts:16–28` and
`apps/worker/src/execution/core-definition-identities.ts:31–36` omit
`core.foreach@1` from V2 selection. A valid workflow without another V2-triggering
node starts with V1, then fails with
`checkpoint_invalid: structured For Each requires checkpoint V2`.

The preceding audit reproduced this using the actual graph compiler, worker
initializer, and engine transitions without external services. Recovery fixtures
manually select V2 and therefore hide the admission defect.

Correction direction: include For Each in both initializers' V2 requirements.
Regression: use actual admission/initialization through the first loop execution,
without supplying a preselected V2 checkpoint in the fixture.

### F03 — P2: finalized uploads retain their pending-upload deadline

Origin: introduced. Areas: database artifact finalization and retention.

Evidence: `packages/database/src/execution/artifact-upload.ts:307` changes status
without changing `expires_at`;
`packages/database/migrations/0080_expired_artifact_upload_retention.sql:19`
selects expired unreferenced uploads. An available upload can consequently be
deleted at its original 15-minute deadline while public metadata reports
`expiresAt: null`.

Correction direction: distinguish pending-upload expiration from finalized
artifact retention. Regression: finalize an upload, advance past its original
pending deadline, run retention, and check metadata and download availability.
Evidence is the traced SQL/application contract, not a fresh live retention run.

### F04 — P2: expiry cleanup can finish before an in-flight replica write

Origin: introduced. Areas: API artifact service, artifact store, database retention.

Evidence: `apps/api/src/artifacts/service.ts:140` starts replication without
coordinating its lifetime with expiry cleanup. Cleanup can delete objects and
metadata and release capacity while a recovery PUT remains pending. A late PUT
then recreates an untracked recovery object.

The preceding audit reproduced the store interleaving: finalization rejected
but recovery bytes remained after the gated PUT completed. This was an in-memory
store reproduction, not live object-storage behavior verification.

Correction direction: retain cleanup authority and capacity accounting until
outstanding writes cannot recreate bytes. Regression: expire an upload while
recovery PUT is gated, complete cleanup, release the write, and assert no orphan
and no premature capacity release.

### F05 — P2: deployment egress excludes API connection tests

Origin: pre-existing. Areas: API connections, deployment network contract.

Evidence: `infrastructure/ecs/external-platform-contract.json:32` excludes
`provider-api` from API egress, while
`apps/api/src/connections/use-cases.ts:303` performs Resend, Slack, and configured
HTTP connection tests inside the API process. A deployment enforcing that
contract blocks those capabilities. This is a source/contract mismatch; the
preceding audit did not observe the production AWS network.

Correction direction: align API egress with existing connection-test behavior.
Regression: exercise all supported connection tests under the enforced network
policy, retaining the application's SSRF protections.

### F06 — P2: early API construction failures bypass resource cleanup

Origin: pre-existing. Areas: API composition, configuration, resource lifecycle.

Evidence: `apps/api/src/app.ts:118–141` constructs runtimes before its first
cleanup guard. Parser-accepted `redis:///0` fails in workflow construction before
that guard is reached, leaving previously created resources unclosed.

The preceding audit used parser output, no-I/O database/workflow overrides, and
an identity-runtime close counter: construction rejected with
`RunEventNotificationConfigurationError`, but the close count stayed zero.

Correction direction: guard partial composition with ownership-aware cleanup
and validate Redis endpoints before allocating resources. Regression: inject
failures during each constructor/factory stage, assert owned resources close,
and preserve the original failure alongside existing readiness-failure tests.

## Additional confirmed findings from the part-by-part pass

### F07 — P3: the schema-grant test cannot see PUBLIC privileges

Origin: pre-existing; no change to this file in the pinned `main...HEAD` diff.
Area: database integration-test correctness. Skill criteria: PostgreSQL grants
and Node test assertions that actually fail for the prohibited state.

Evidence: `packages/database/test/schema-shape.integration.test.ts:155–161`
expands ACL entries, then inner-joins `pg_roles` on the grantee OID. PostgreSQL
represents PUBLIC as grantee zero, which has no `pg_roles` row. PUBLIC entries
are therefore removed before the assertion at `:182` checks that the resulting
set does not contain `PUBLIC`. Adding a PUBLIC grant would not make that
assertion fail. This weakens the raw-table grant regression gate; it does not
establish that the current migrations expose data to PUBLIC.

Fresh read-only PostgreSQL probe:

```sql
WITH public_acl AS (
  SELECT * FROM aclexplode(ARRAY['=r/pertexo_owner']::aclitem[])
)
SELECT
  (SELECT count(*) FROM public_acl WHERE grantee = 0) AS public_grants,
  (SELECT count(*) FROM public_acl acl
   JOIN pg_roles role ON role.oid = acl.grantee) AS rows_seen_by_audit_query;
```

Observed result: `public_grants = 1`, `rows_seen_by_audit_query = 0`. No roles,
grants, or application data were changed by the probe.

Correction direction: preserve the zero-OID ACL entry with an explicit PUBLIC
label, or assert its absence before joining named roles. Regression: on a
disposable fixture, inject a PUBLIC table grant and prove the validator fails;
then remove it and prove the normal schema passes.

### F08 — P2: Error.name bypasses log redaction and text bounds

Origin: pre-existing; no change to this file in the pinned `main...HEAD` diff.
Area: observability logger. Evidence:
`packages/observability/src/logger.ts:214` copies `error.name` verbatim into the
otherwise sanitized Error. Pino emits that enumerable property as `err.name`.
The same redaction and 16 KiB text bound used for message and stack do not apply
to it, including Errors nested in causes. This violates the logger's tested
hostile-error/redaction boundary; it is not evidence of a current production
credential leak or an unauthenticated exploit.

Primary-reviewer reproduction used the actual logger with an in-memory sink:
an Error with `message = 'token=audit-sentinel-message'` and
`name = 'token=audit-sentinel-name'` produced
`{ nameRedacted: false, messageRedacted: true }`. A second Error with a
20,000-character name emitted all 20,000 characters. No actual secret was used.

Correction direction: sanitize and bound the name before serialization, or
accept only bounded error classification names with a safe fallback. Regression:
check credential-shaped and oversized names in both top-level errors and causes,
while retaining useful ordinary class names.

### F09 — P2: trigger OpenAPI documents omit required authentication and headers

Origin: pre-existing; neither source file changed in the pinned `main...HEAD`
diff. Areas: contracts and API request boundaries.

Evidence: `packages/contracts/src/schedules.ts:37–77` and
`packages/contracts/src/webhooks.ts:59–110` describe management operations
without a session security scheme or required `Idempotency-Key` and
`X-CSRF-Token` header parameters. The client-contract arrays in the same files
declare those headers, while `apps/api/src/schedules/controllers.ts:46–100`
and `apps/api/src/webhooks/controllers.ts:51–112` enforce session authentication,
authorization, CSRF protection and idempotency parsing. The documents also omit
the corresponding 403 responses and typed success bodies. Webhook ingress
likewise omits the timestamp/signature headers declared in its client contract.

A fresh primary-reviewer inspection of both generated `.openapi.json` artifacts
confirmed no root/operation security, no security schemes, no header parameters
and no 200 response content schemas for these management operations. A generated
client relying on OpenAPI therefore lacks material required to make valid
requests or type their successful results, despite `contracts:check` passing.
This is a semantic contract/client-generation defect, not an authentication
bypass; the runtime guards are present.

Correction direction: publish security, required headers and response schemas
consistent with the actual routes, separating signed public ingress from
session-authenticated management. Regression: compare generated operations
against client-contract headers and guarded-route success/error fixtures, not
only OpenAPI syntax and generated-file freshness.

## Verification from the preceding source pass

Primary-reviewer executions below were completed before implementation and are
retained as baseline evidence. Fresh post-implementation evidence is recorded
in the final verification section.

| Check | Result | What this establishes |
| --- | --- | --- |
| `pnpm build` | Passed | Production TypeScript project build |
| `pnpm architecture:check` | Passed; 15 assertions | Workspace ownership, runtime import cycles, project references |
| `pnpm database:schema:check` | Passed; 1 assertion | 68 migration-owned tables accounted for: 49 typed, 19 reviewed raw SQL |
| `pnpm contracts:check` | Passed | Generated contract consistency and all eight OpenAPI documents validate |
| `pnpm lint` | Passed | Repository ESLint rules |
| `pnpm dependencies:check` | Passed | Knip dependency/export checks |
| `pnpm complexity:check` | Passed; 2 assertions | No new or worsened hotspot against the existing baseline, not absence of complexity |
| `pnpm duplication:check` | Passed; 6 assertions | Reviewed duplication baseline: source 27 groups / 512 lines; tests 4 groups / 203 lines |
| `pnpm deployment:check` | Passed; 29 assertions | Local deployment contract, runtime closure, parser compatibility, deterministic rendering; not live AWS proof |
| `pnpm docs:check` | Passed; 13 assertions | Documentation links, historical tree consistency, operational-documentation checks |
| `pnpm runtime:check` | Passed; 15 assertions | Node 24 configuration consistency |
| `pnpm --filter './packages/*' --recursive --if-present typecheck` | Passed in all 12 packages | Test/support TypeScript compilation in addition to production build |
| Database `vitest run --config vitest.integration.config.ts test/retention-artifacts.integration.test.ts` | Passed; 4 tests | Real local PostgreSQL disposable fixtures; object-store operations mocked; does not cover F01/F04 in-flight interleavings |
| Read-only PostgreSQL PUBLIC ACL probe | Reproduced F07 | One PUBLIC ACL entry disappears from the test's inner join |
| In-memory structured logger probe | Reproduced F08 | Name leaks sentinel while message redacts; 20,000-character name remains unbounded |
| Database disposable runtime/schema/hygiene/cancellation integration selection | Passed; 4 files / 11 tests | Shared-pool ownership, schema shape, tenant context cleanup, wire cancellation and rollback; local PostgreSQL only |
| Node SDK/catalog/core/model/engine unit rerun by primary reviewer | Passed; 539 tests | 38 / 17 / 96 / 94 / 294 respectively |
| Lifecycle-command/operator-command/recovery/retention tests | Passed; 54 tests | 25 / 8 / 10 / 11 respectively; lifecycle includes actual compiled-process signal and exit tests with mocked external resources |
| `pnpm --filter './apps/*' --recursive --if-present typecheck` | Passed in all 6 apps | Production and test/support type contracts |
| Artifact-store/contracts/integrations/observability/queue/rate-limit unit rerun | Passed; 617 tests | 209 / 36 / 223 / 65 / 55 / 29 respectively; external integration suites excluded |
| Database/API/worker unit rerun | Passed; 991 tests | 238 / 476 / 277 respectively; configured unit cohorts, not integration/resilience suites |

Together these primary-reviewer reruns passed **2,201 package/app tests** plus
**15 selected local PostgreSQL integration tests**. This total excludes duplicate
worker-agent executions and repository-level guardrail checks listed above.

## Expanded coding-quality assessment by part

This section assesses how the code is written, not merely whether the configured
tests pass. It uses Node guidance throughout; NestJS guidance for the API, worker
and observability Nest adapter; PostgreSQL guidance for persistence and the apps
that orchestrate it; and module-depth/architecture guidance for responsibility
ownership and file layout. Existing ADRs and capability exports remain authoritative.
No frontend, Prisma, complex-type, or test-first skill was applied to unrelated code.

The source inventory covers all 18 parts. Each assessment considers naming and
navigation, repeated patterns, unnecessary conditions, authorization versus
defensive validation, policy constants, nesting, responsibility ownership,
type/error contracts, async/resource safety, and behavioral tests. Test inspection
is not exhaustive for database, as explicitly recorded below. A test-file count
is not a coverage percentage, and a large file is not automatically a bad module.

### Verdict key and matrix

- **M — Meets:** inspected evidence supports the criterion; no required change
  identified on that axis. This is not a claim of perfection.
- **N — Needs changes:** a concrete defect, maintainability finding, or missing
  regression is described in the part's assessment.
- **R — Retained debt:** readability/complexity friction exists, but a broad
  extraction is not justified without the named characterization. This is not M.
- **U — Unverified:** insufficient evidence for an exhaustive verdict.

“Runtime” is the code-level assessment, not a live-service certification. F-prefixed
findings are the nine existing defects; CQ-prefixed findings below are additional
maintainability/test work and are not counted as new correctness defects.

| Part | Names / layout | Guards / constants | Readability | Interfaces / ownership | Runtime / data / errors | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| `packages/artifact-store` | M | M | R | M | M; F04 integration risk | M; AWS unverified |
| `packages/contracts` | M | M | M | N: F09 parity | N: F09 | N: F09 regression |
| `packages/database` | M | N: CQ03 | R | N: CQ03 | N: F01/F03 | N: F07; U: exhaustive inspection |
| `packages/integrations` | M | M | R | M | M; F05 deployment risk | M; providers unverified |
| `packages/node-catalog` | M | M | M | N: CQ04 | M | M |
| `packages/node-sdk` | M | M | R | M | M | M |
| `packages/nodes-core` | M | M | M | M | M | M; F02 app seam gap |
| `packages/observability` | M | M | M | M | N: F08 | N: F08 regression |
| `packages/queue` | M | M | R | M | M | M; live transport unverified |
| `packages/rate-limit` | M | M | M | M | M | M; live Redis unverified |
| `packages/workflow-engine` | M | M | R | M | M | M; F02 app seam gap |
| `packages/workflow-model` | M | M | R | M | M | M |
| `apps/api` | N: CQ01/CQ05 | M | N: CQ01; R: ingress/OIDC | N: CQ01 | N: F02/F04/F05/F06 | N: production seam regressions |
| `apps/lifecycle-command` | M | M | M | M | M | M |
| `apps/operator-command` | M | M | M | M | M | N: CQ02 |
| `apps/recovery` | M | M | M | M | M | M; live restore unverified |
| `apps/retention` | M | N: CQ03 | M | N: CQ03 | N: F01/F03/F04 integration | N: destructive interleaving regressions |
| `apps/worker` | M | M | R | R: capability composition | N: F02 integration | N: F02 production-selector regression |

### `packages/artifact-store`

- **Names/layout:** artifact metadata, downloads, regional orchestration and
  control-ledger modules are named for their jobs. `store.ts` is broad but its
  package context is meaningful; `artifact-download.ts` and
  `dual-region-artifact-store.ts` make the distinct capabilities discoverable.
- **Guards/constants:** metadata, checksum, request deadline and closed-state
  checks protect different invariants. In `src/control-ledger.ts:638`, the empty
  projection check and the later nonempty anchor checks are different cases,
  not redundant `if` statements. Record limits are named.
- **Readability:** ledger reconciliation (`src/control-ledger.ts:638`) and paged
  purge (`src/store.ts:668`) mix validation with ordered external work. Retain as
  explicit debt under the complexity register; a future private extraction must
  preserve pagination, hash-chain checks and delete acknowledgement ordering.
- **Interfaces/types:** `AwsArtifactStore` implements storage, download and purge
  capabilities (`src/store.ts:403`) while sharing one client and ownership policy.
  That alone is not a single-responsibility failure: callers already have narrow
  capability interfaces. Splitting it into separately owned clients would add
  lifecycle complexity without established leverage.
- **Runtime/tests:** request cancellation, stream destruction, checksum checks
  and owned-versus-borrowed close are explicit (`src/store.ts:480`, `:759`). Tests
  exercise corruption, cancellation, purge and ledger concurrency through the
  interfaces. F04 concerns a wider upload/retention protocol that these mocked
  object-store tests do not prove; real AWS/Object Lock behavior remains unverified.

### `packages/contracts`

- **Names/layout:** domain files and `openapi-primitives.ts` give schemas and
  document construction clear homes (`src/artifacts.ts:31`,
  `src/openapi-primitives.ts:6`). Generated artifacts are distinct from source.
- **Guards/constants/readability:** small declarative schemas are appropriate;
  adding imperative guards around every schema would duplicate validation.
  Named enums and bounded schemas are preferable to scattering raw accepted values.
- **Interfaces/duplication:** route descriptors and OpenAPI paths are independently
  maintained (`src/schedules.ts:17`, `:59`; `src/webhooks.ts:24`, `:95`). F09 shows
  actual drift in required request metadata, not merely similar-looking code.
  Add parity validation or one authoritative metadata model; do not redesign the
  entire contract package just to fix these routes.
- **Runtime/types/tests:** Zod schemas provide runtime parsing and inferred types,
  but valid OpenAPI syntax does not prove endpoint fidelity. Schedule/webhook
  tests (`test/schedules.test.ts:28`, `test/webhooks.test.ts:8`) cover schema inputs,
  not the missing security/header declarations. Add assertions that cross the
  generated-document/actual-route seam as part of F09.

### `packages/database`

- **Names/layout:** capability directories such as `execution`, `lifecycle`,
  `tenant-access`, `connections`, `triggers`, `authoring`, `operator`, `platform`
  and `validation` express ownership. Long names such as
  `execution/coordinator-run-store-commit-state.ts` are specific rather than
  mysterious: they identify the operation and persistence role. Flattening the
  package or shortening these to `helpers.ts` would worsen navigation.
- **Guards/constants:** transaction/lease/workspace/fence checks are not redundant
  with HTTP authorization or RLS. CQ03 is a real exception to good policy locality:
  the retention batch size is duplicated in SQL invocation, row validation and
  the calling app's polling decision (`src/lifecycle/retention.ts:572`).
- **Readability:** large transaction factories and state transitions remain debt.
  The current complexity scan identifies `workspace-purge.ts#processNext` at
  513 lines/46 branches and the coordinator-observation callback at 263/37.
  Factory size with few branches differs from decision complexity; neither is
  excused as “clean” merely because the ratchet passes. Keep lock/query/commit
  order local until a behavior-preserving extraction has real PostgreSQL evidence.
- **Interfaces/types/errors:** capability exports and workspace transaction
  ownership are useful deep modules; typed schemas coexist with reviewed raw SQL.
  Do not spread transaction ownership into apps or invent a repository abstraction
  per query. Two retained locality concerns deserve explicit acknowledgment:
  `src/lifecycle/retention.ts:107` exposes dry-run execution, scheduling, reruns,
  reaping and lag observation in one interface; connection persistence is similarly
  broad but provides role-specific `Pick` views (`src/connections/connection-persistence.ts:325`).
  Also, child implementations import types from their composing parent
  (`src/authoring/workflow-authoring-drafts.ts:24` imports `workflow-authoring.ts`,
  which imports that child at `:24`; `src/tenant-access/identity-workspace-rows.ts:4`
  has the same type-ownership pattern). These erased cycles are not runtime import
  cycles, but they make contract discovery less local. Consider leaf-owned
  contracts and capability-specific internal implementations when those modules
  next change, preserving public exports and transaction ownership. F01/F03 are
  actual lifecycle invariant failures requiring coordinated corrections, not
  naming changes.
- **Tests:** selected pool ownership, RLS, migration, cancellation, schema and
  transaction tests provide good behavioral evidence. F07 weakens the grants gate.
  The 26-file explicitly reconciled test/support subset and 133-file remaining
  manual-inspection limit still apply; this report does not convert passing unit
  tests into a claim that every database test is well written or complete.

### `packages/integrations`

- **Names/layout:** `credentials`, `crypto`, `http`, `email` and `slack` separate
  policy, cryptography and provider implementations. Repeated `executor.ts` names
  are readable inside provider directories and make corresponding roles easy to find.
- **Guards/constants:** executor parsing is intentionally repeated at a directly
  callable seam (`src/email/executor.ts:125`, `src/slack/executor.ts:120`). Identity,
  auth-type and pre-dispatch currency checks each protect a different invariant;
  deleting them because the registry also validates would weaken the contract.
- **Readability/duplication:** HTTP DNS/TLS/redirect admission remains a retained
  ordered security path. Email and Slack have parallel parse/resolve/dispatch/
  zeroize flows (`src/email/executor.ts:119`, `src/slack/executor.ts:114`), but email
  is idempotent-with-key and Slack is unsafe after possible dispatch. Their cancel,
  retry and unknown-outcome branches differ materially. Retain those differences;
  do not introduce a generic provider executor solely to remove similar lines.
- **Interfaces/types:** narrow injected clients and telemetry contracts
  (`src/email/executor.ts:43`, `src/slack/executor.ts:59`) isolate provider behavior.
  Shared pre-dispatch fencing is already factored without hiding classification.
- **Runtime/tests:** byte/time bounds, SSRF policy, secret zeroization and typed
  ambiguous outcomes are strong. Tests cover fences, cancellation, retry and
  hostile responses. F05 concerns actual API egress configuration; mocked provider
  tests cannot certify that deployment or live provider behavior.

### `packages/node-catalog`

- **Names/layout:** `definition-resolution.ts` owns browser-safe definition lookup;
  `server.ts` owns executable assembly. Keeping these distinct preserves the
  browser/server split rather than applying identical imports everywhere.
- **Guards/constants/readability:** release identity is verified before resolution
  (`src/definition-resolution.ts:23`); unsupported definitions/executors fail
  closed. Explicit registration and executor selection is easier to inspect than
  reflective discovery of whatever happens to be imported.
- **Interfaces/duplication:** CQ04 identifies the same platform definition list
  in `src/definition-resolution.ts:48` and `src/server.ts:62`. Adding a provider
  requires updating both paths. Centralize only the browser-safe registration
  data; do not make browser consumers import server executors.
- **Runtime/types/tests:** readonly registry/dependency contracts
  (`src/server.ts:40`) and release history tests pin exact manifests, schemas and
  compatibility (`test/release-history.test.ts:561`). Construction/execution and
  package export tests are behavior-based evidence. No additional runtime defect
  is established by the duplicated list.

### `packages/node-sdk`

- **Names/layout:** `identity.ts`, `json-boundary.ts`, `release.ts`, `server.ts`
  and explicit entrypoints separate identity, bounded values, compatibility and
  execution. Here `server.ts` means the server-only registry/execution entrypoint,
  not an HTTP listener; renaming it without considering package exports is unwarranted.
- **Guards/constants:** ABI versions and connection-reference limits are bounded
  (`src/server.ts:85`, `:124`); config/input/output errors are mapped explicitly
  (`:184`). Runtime validation is justified for external and persisted values
  even when TypeScript callers have compile-time types.
- **Readability:** release and registry construction are substantial retained
  compatibility modules. Their size is debt, but fingerprinting and successor
  checks must remain canonical. Do not split version grammar into speculative
  mini-modules just to lower a number.
- **Interfaces/duplication:** the registry offers catalog, dispatch and execution
  (`src/server.ts:103`). Duplicate-identity loops in `src/release.ts:288` and
  `src/server.ts:167` differ in error contracts; identity-list comparison also uses
  different algorithms (`release.ts:377`, `server.ts:129`). These are low-impact
  cleanup opportunities, not proven bugs or reasons to unify validation ownership.
- **Runtime/tests:** stable typed failures and abort checks are explicit. Registry
  tests exercise browser/server parity, hostile JSON, duplicate identities and
  schema drift (`test/registry.test.ts:412`, `:589`); package-contract tests protect
  server-only exports. No required new SDK fix was found on these axes.

### `packages/nodes-core`

- **Names/layout:** per-node definitions/executors and explicit versioned imports
  (`src/definitions.ts:3`, `src/registrations.ts:8`) make behavior and retained
  releases discoverable. Similar node directories use similar roles without
  unnecessary Nest-style folders in this pure package.
- **Guards/constants/readability:** registration validation rejects duplicate or
  missing bindings (`src/registrations.ts:43`); successor epoch/fingerprint checks
  (`src/server.ts:41`) are meaningful compatibility checks, not defensive clutter.
- **Interfaces/types:** immutable registration arrays and small registry contracts
  (`src/definitions.ts:88`, `src/server.ts:25`) expose useful behavior. Tiny local
  `identityToken` helpers (`registrations.ts:39`, `server.ts:21`) are not worth a
  new cross-package utility abstraction on their own.
- **Runtime/tests:** retained-registry tests check exact binding, immutability,
  successor rejection and unshipped implementation rejection
  (`test/retained-registry.test.ts:33`, `:87`). F02 is the app's initial-checkpoint
  selection problem, not evidence that the core For Each definition should be
  renamed or made responsible for workflow admission.

### `packages/observability`

- **Names/layout:** logger, telemetry sanitization, metrics, tracing, runtime and
  Nest adaptation have clear homes. `nest-runtime.ts` is an adapter, not a reason
  for the whole package to depend on app internals.
- **Guards/constants/readability:** bounded sanitizer helpers make recursive
  handling reviewable (`src/logger.ts:155`, `src/telemetry-sanitization.ts:11`).
  Metrics factories with many instruments but little branching should not be
  confused with tangled decision logic.
- **Interfaces/types:** `StructuredLogger` and telemetry lifecycle contracts
  (`src/logger.ts:12`, `src/nest-runtime.ts:153`) keep calling code small. Broad
  arbitrary payloads are narrowed/sanitized at the logging seam, not trusted
  merely because TypeScript describes a record.
- **Runtime/tests:** F08 is the exception: `sanitizeError` copies `Error.name`
  verbatim (`src/logger.ts:195`). Existing hostile-message/stack tests missed
  names. Add oversized, secret-bearing and nested error-name cases; passing
  telemetry tests do not justify a blanket error-sanitization verdict.

### `packages/queue`

- **Names/layout:** producer, consumer, delivery admission, contract, Redis
  endpoint and notification modules describe their roles. There is no need to
  impose app feature-controller naming on this transport adapter.
- **Guards/constants:** lease/admission/acknowledgement checks and bounded
  operation deadlines serve different stages. Endpoint normalization has one
  named implementation (`src/redis-endpoint.ts:3`).
- **Readability:** producer methods and consumer lifecycle helpers keep decisions
  local (`src/producer.ts:220`, `src/consumer.ts:430`), but the stateful consumer
  remains retained complexity. Splitting redelivery from drain/acknowledgement
  without characterization would obscure the ordering that matters.
- **Interfaces/types:** producer, consumer, handler, tracing and observation
  contracts (`src/producer.ts:43`, `src/consumer.ts:45`) are suitably narrow.
  Small repeated error adapters do not justify an additional shared package.
- **Runtime/tests:** ownership-aware close, deadline handling, outcome-unknown
  publication and forced drain are explicit. Tests cover admission, cancellation,
  endpoint identity and lifecycle. Most transport tests use doubles; live
  Redis/BullMQ outage/redelivery behavior remains a separate verification layer.

### `packages/rate-limit`

- **Names/layout:** four focused modules separate policy, script protocol and
  Redis runtime; the small package does not need deeper folders.
- **Guards/constants/readability:** policy evaluation is compact
  (`src/policy.ts:171`); script responses are validated before use
  (`src/distributed-rate-limiter.ts:71`). `DEFAULT_OPERATION_TIMEOUT_MS` and
  bounded timeout parsing (`src/redis-runtime.ts:13`, `:114`) expose policy intent.
- **Interfaces/types:** the script-executor seam and decision/result types are
  narrow (`src/distributed-rate-limiter.ts:10`). Concurrent connection deduplication
  belongs to the Redis adapter, not callers.
- **Runtime/consistency:** queue normalizes endpoints while this runtime accepts
  a string (`src/redis-runtime.ts:23`). Current API and worker configs already
  validate Redis URL schemes; no in-scope bad-endpoint failure is demonstrated.
  Treat package-level validation alignment as optional hardening, not a new
  runtime defect or permission to add a dependency on queue internals.
- **Tests:** script validation, timeout/reconnect, concurrent connect and
  close/connect races are exercised. These are meaningful runtime tests; the
  live Redis deployment was not verified by the unit cohort.

### `packages/workflow-engine`

- **Names/layout:** checkpoint versions, executable validation, scheduling,
  observations and transitions are distinct modules with curated exports
  (`src/index.ts:3`). Long operation-specific names convey domain meaning.
- **Guards/constants:** readonly transition tables (`src/transitions.ts:4`) and
  named terminal dispositions (`src/scheduling.ts:13`) avoid scattered policy.
  Recursive checkpoint/graph membership validation is not redundant with JSON
  shape parsing; it establishes semantic compatibility.
- **Readability:** checkpoint grammar and scheduling functions retain considerable
  decision complexity. `assertCheckpointMatchesExecutable` currently measures
  168 lines/42 branches. Keep this as explicit debt; avoid hiding transition order
  inside generic rule pipelines solely to satisfy line/branch limits.
- **Interfaces/types/errors:** public operations use typed inputs/results
  (`src/operations.ts:64`); `WorkflowEngineError` has a closed code union
  (`src/errors.ts:1`). The engine remains portable rather than importing worker
  resources or database ownership.
- **Tests:** For Each admission, empty/over-limit cases and stable keys
  (`test/foreach-scheduling.test.ts:10`) and executable identity tests
  (`test/executable-workflow-identity.test.ts:22`) exercise public behavior.
  F02 demonstrates why these tests must be complemented by the app's production
  selector/admission path; fixtures that already choose V2 cannot prove that path.

### `packages/workflow-model`

- **Names/layout:** graph and expression subdirectories are appropriate for
  growing subdomains; `canonical-json.ts`, `lifecycle.ts` and `mapping.ts` remain
  readable standalone modules. Neither one giant model file nor a directory per
  tiny helper would improve this layout.
- **Guards/constants:** canonical JSON enforces depth, cycles, plain-object and
  accessor rules (`src/canonical-json.ts:29`); graph validation applies bounded
  schemas and structural checks (`src/graph/validation.ts:17`, `:74`). These are
  separate input hazards, not repetitive null checking.
- **Readability/interfaces:** pure lifecycle decisions (`src/lifecycle.ts:36`)
  and small canonicalization entrypoints (`src/canonical-json.ts:108`) provide
  good leverage. Expression worker supervision and graph grammar retain complexity;
  preserve one owner for worker timing/message order and canonical graph semantics.
- **Runtime/errors/tests:** evaluator limits, typed errors, cancellation and
  shutdown are explicit (`src/expressions/evaluator.ts:29`, `:79`, `:151`). Tests
  exercise normalization, hostile/cyclic/deep values and lifecycle convergence
  (`test/canonical-json.test.ts:9`, `test/lifecycle.test.ts:36`) as well as graphs
  and expression policy. No required new model change was identified.

### `apps/api`

- **Names/layout:** feature-owned controllers, guards, modules, ports and errors
  are consistent with NestJS. CQ01 identifies a broad `connections/use-cases.ts`
  containing several change reasons. CQ05 identifies smaller token-placement
  inconsistency. Singular `node-testing/controller.ts`/`use-case.ts` versus plural
  files containing multiple classes is intentional, not a naming defect.
- **Guards/constants:** session authentication, CSRF and workspace capability
  checks are separate policies (`src/identity-workspace/guards.ts:34`, `:63`,
  `:82`). Read/cancel guards admit lifecycle states that start/replay guards do
  not (`src/workflow-runs/guards.ts:9`, `:24`, `:35`, `:46`). Preserve the repeated
  state lists unless one named policy genuinely owns identical semantics.
  Post-encryption/revocation abort checks also protect against cancellation during
  an await; they are not redundant with request-entry checks.
- **Readability:** CQ01's connection test path combines provider branches and
  mapping with orchestration. Conversely, OIDC validation and webhook ingress
  remain ordered security-sensitive debt; the long declarative Nest registration
  methods are not “complex” merely because they list many providers.
- **Interfaces/types/errors:** constructor injection and feature ports expose
  testable seams. HTTP/problem-details mapping remains centralized. Avoid merging
  feature ports into a universal repository or moving workspace authorization
  into generic decorators that hide the capability/status policy.
- **Runtime/tests:** The original F02/F04/F05/F06 and F09 gaps are resolved by
  the implementation and evidence table above.
  Existing HTTP-injection and use-case tests are useful but do not cover the exact
  production For Each initializer, early resource-construction failure, or late
  replica-write interleavings. Those need focused regressions through composition
  and persistence seams, not more assertions on already-correct isolated helpers.

### `apps/lifecycle-command`

- **Names/layout:** `config.ts`, `main.ts`, `run.ts`, `readiness-marker.ts` are
  sufficient for four focused source files; the package name supplies context.
  `runLifecycleCommandWorker` names the long-running responsibility explicitly.
- **Guards/constants/readability:** timeout-versus-lease bounds are validated in
  configuration. The runner distinguishes idle/released/stale polling outcomes
  and expected abort from real failure (`src/run.ts:23`). The `operationFailed`
  flag is intentional: it does not conflate a thrown `undefined` with no failure.
- **Interfaces/types:** injected bootstrap modules/resources
  (`src/main.ts:21`, `:43`, `:63`) and a two-operation readiness-marker interface
  make ownership testable without introducing a shared process framework.
- **Runtime/tests:** readiness is cleared before startup and during teardown;
  every cleanup operation is attempted and failures are aggregated. Bootstrap
  tests cover partial construction and listener removal (`test/main.test.ts:159`);
  runner tests cover abort/error distinctions (`test/run.test.ts:162`, `:196`)
  and compiled-process tests cover actual signal/exit behavior. External resources
  are mocked. No required coding-quality change was identified here.

### `apps/operator-command`

- **Names/layout:** `config.ts`, `main.ts`, `run.ts` follow the same small-app
  convention. The discriminated command names say what changes operational state.
- **Guards/constants/readability:** explicit command dispatch in `src/run.ts:42`
  is clearer than dynamic method lookup for privileged operations. Configuration
  requires bounded actor/reason/identity and mutation material; timeout cleanup
  is isolated in `boundedCleanup` (`src/run.ts:21`). Repeated command fields
  make audit material explicit rather than justifying a generic command framework.
- **Interfaces/types:** the runner receives a database capability, logger,
  telemetry and signal. The result union follows the command family; one logging
  assertion about `replayed` is a small narrowing opportunity, not a reason for
  advanced type machinery or a new abstraction.
- **Runtime/tests:** operation errors and cleanup errors are aggregated; startup
  tracks whether ownership transferred to the runner (`src/main.ts:18`, `:36`,
  `:55`). CQ02 is a concrete weakness: `test/run.test.ts:8` exercises only successful
  redispatch. Other routing, null status, cancellation, timeout and aggregate-error
  behavior need direct tests. Configuration tests do not establish runner behavior.

### `apps/recovery`

- **Names/layout:** `restore-before-serve.ts` is more informative than a generic
  `run.ts` for this one-shot gate. This intentional difference from daemon apps
  improves clarity; identical filenames are not the goal.
- **Guards/constants/readability:** pagination is bounded, explicitly rejects
  no progress, and advances both workspace/artifact cursors
  (`src/restore-before-serve.ts:43`). Sequential replica verification is visible
  and bounded; unbounded `Promise.all` would not automatically be an improvement.
- **Interfaces/types:** readiness, inventory and artifact verification sit behind
  a typed resource/result interface (`src/restore-before-serve.ts:17`, `:37`).
  The private inventory function keeps hashing/pagination out of bootstrap.
- **Runtime/tests:** readiness precedes reconciliation; failure still attempts
  cleanup (`src/restore-before-serve.ts:88`). Tests cover readiness order, bad
  replicas, page bounds, cancellation and cleanup failure
  (`test/restore-before-serve.test.ts:177`). Real multi-region restoration and
  bootstrap process behavior are not established by these mocked runner tests;
  no new source-level defect is inferred from that limitation.

### `apps/retention`

- **Names/layout:** `maintenance-loops.ts`, `metrics.ts`, `run.ts`, `config.ts`
  and `main.ts` separate scheduling, observation and process ownership cleanly.
- **Guards/constants:** named capped failure backoff and deduplicated readiness
  gates are clear (`src/maintenance-loops.ts:15`, `:37`, `:54`). CQ03 identifies
  the unexplained cross-package `scannedCount < 25` at `:152`.
- **Readability/interfaces:** eight named loops are repetitive but have different
  progress/pause conditions. Shared failure/recovery/readiness helpers already
  remove mechanical repetition. Do not replace all loops with a configurable
  mini-framework that hides when purge/enforcement continue or wait.
- **Runtime/types:** supervision is joined before ordered resource cleanup
  (`src/run.ts:38`, `:64`, `:70`). Keeping database-only maintenance independent
  from artifact/ledger readiness is intentional availability policy.
- **Tests:** `test/run.test.ts:215`, `:289`, `:339` exercise per-operation metrics,
  backoff and failure isolation. F01/F03/F04 require hold/deletion/finalization and
  in-flight PUT regressions at the database/storage orchestration seam. Current
  green loop tests do not establish those destructive protocols are safe.

### `apps/worker`

- **Names/layout:** `execution`, `transport`, `runtime`, `triggers`, `platform`
  and `config` separate attempt behavior, delivery, process supervision and Nest
  wiring. `node-attempt-handler`, `node-attempt-engine` and `node-attempt-runtime`
  describe different responsibilities; renaming them all to `service` would lose
  information. Provider-specific telemetry filenames remain discoverable.
- **Guards/constants:** identity/checksum/fence/dispatch-evidence guards protect
  different trust and timing stages (`src/execution/node-attempt-handler.ts:178`).
  `beforeDispatch` must reject duplicate dispatch and establish durable evidence;
  it is not redundant with claim admission. Outbox capacity sample intervals and
  bounds are named (`src/transport/outbox-dispatcher.ts:100`).
- **Readability/ownership:** attempt and preview handlers retain nested heartbeat,
  cancellation, execution and completion sequencing. Capability composition also
  contains both credential resolution and artifact spooling
  (`src/execution/node-runtime-capabilities.ts:108`, `:218`, `:371`). This is real
  navigation/readability debt, but the public factory is already small and owns
  shutdown. A future private connection/artifact split must retain that single
  ownership interface; do not create another public lifecycle for each helper.
- **Types/errors/runtime:** outcome unions distinguish duplicate, committed,
  failed and unknown outcomes; errors are translated at execution seams. Secret
  zeroization after canceled decryption, bounded spool writes, finalization and
  cleanup are explicit. Best-effort Redis resync failure is deliberately ignored
  after PostgreSQL commits (`src/execution/node-attempt-handler.ts:150`), not an
  accidentally swallowed authoritative failure.
- **Tests:** capability tests cover partial construction, borrowed runtime,
  cleanup failure, currency checks, zeroization, stream bounds and retention
  deadlines (`test/node-runtime-capabilities.test.ts:63`, `:406`, `:552`, `:728`).
  Process tests and lease/fence/outcome tests are useful. F02 still needs a
  regression through production initial-checkpoint selection rather than fixtures
  that preselect V2; full destructive resilience suites were not freshly executed.

## Additional maintainability and test findings

These are reviewable work items, not implementation changes and not additional
P1/P2 correctness defects. P3 means focused maintenance priority. Retained
state-machine/security complexity above is separately acknowledged, not silently
marked resolved or made an instruction for a repository-wide rewrite.

### CQ01 — P3: connection orchestration is hidden in one broad file

`apps/api/src/connections/use-cases.ts:85`, `:144`, `:207` and `:233` hold create,
rotate, revoke and test use cases; `:404` onward also contains credential decoding,
provider outcome mapping, hashing and response serialization. The test use case
combines three provider branches with nested exception handling. A provider-test
change requires navigating a 575-line file also owning unrelated mutation flows.
This is a concrete responsibility/discoverability issue, not a prohibition on
multiple classes per file. It was already retained pending a focused feature-local
split in the complexity register.

Direction: give connection testing and its provider outcome mapping an explicit
feature-local home; keep shared command types/serialization local to the feature,
and avoid one trivial forwarding file per class. Keep the current public use-case
interfaces and DI behavior. Verify create/rotate/revoke cancellation after external
work, secret cleanup, test authorization and every provider classification before
and after any extraction. Do not move or remove security checks to make it shorter.

### CQ02 — P3: operator runner tests do not exercise its operational contract

`apps/operator-command/src/run.ts:42` routes ten command variants and handles
readiness, cancellation, null status, operation failure and bounded cleanup.
`apps/operator-command/test/run.test.ts:8` contains one successful redispatch test.
Seven config tests do not cover that dispatch/teardown behavior.

Direction: add a table-driven runner test for each command-to-method mapping and
forwarded audit fields, plus null status, pre-abort/readiness failure, operation
failure, cleanup timeout and multiple cleanup failures. Assert other operations
are not called and cleanup is attempted exactly as owned. Test through
`runOperatorCommand`; do not export `boundedCleanup` solely to test an implementation
detail. No current dispatch failure was demonstrated.

### CQ03 — P3: retention batch capacity leaks into its caller

`packages/database/src/lifecycle/retention.ts:572` calls the scheduler with `25`;
`:585` and `:591` repeat that limit in result validation.
`apps/retention/src/maintenance-loops.ts:152` independently uses
`result.scannedCount < 25` to decide whether to pause. Changing the database batch
capacity requires knowledge of a literal in another workspace. The SQL function
also enforces `1..25` in
`packages/database/migrations/0055_standard_retention_classes.sql:170`; changing
that bound would require a new forward migration, not editing migration history.
The values agree today; this is policy duplication/change coupling, not a
demonstrated busy-loop bug.

Direction: keep knowledge of whether a batch was capacity-limited with its owning
database operation, or use an explicitly shared capacity policy if that is truly
part of the existing interface. A local `const` in each file would only rename
the duplication. Verify empty, partial and capacity-filled batches and the app's
pause/drain behavior together. Any interface change requires separate design and
implementation authorization; this audit does not prescribe a new signature.

### CQ04 — P3: catalog registration has two update sites

`packages/node-catalog/src/definition-resolution.ts:48` and
`packages/node-catalog/src/server.ts:62` independently enumerate core, HTTP, Slack
and email definition registrations. A newly shipped definition can be wired into
server execution without browser-safe lookup, or vice versa. Existing values agree.

Direction: use one browser-safe definition-registration collection within the
catalog implementation, retaining separate server executor assembly. Verify both
lookup and executable construction for every supported definition/release and
preserve package export/browser-safety tests. No new package or generic registry
framework is needed.

### CQ05 — P3: API authorization tokens have inconsistent homes

Most features expose DI tokens from `tokens.ts`, for example
`apps/api/src/connections/tokens.ts` and `apps/api/src/workflow-runs/tokens.ts`.
Schedules and webhooks instead define their authorization tokens inside
`guards.ts:7`; their modules must import token data from guard implementations.
This makes the same dependency-wiring task follow different navigation patterns.
It is a small consistency issue, not an authorization vulnerability.

Direction: align token ownership within those features with the established
feature-local convention when next editing them. Preserve symbol identity and
module bindings; verify Nest construction and read/update authorization. Do not
move every token into a global registry or rename otherwise clear feature files.

## Cross-part conventions and retained decisions

The right consistency is **the same role has a predictable home**, not identical
folder trees regardless of purpose:

| Role | Existing convention to preserve | Audit disposition |
| --- | --- | --- |
| Package entrypoints | Explicit `index.ts` and server/testing/capability exports | Keep curated exports; no app-to-package source traversal |
| Nest feature | Feature directory with controller(s), guards, module and owned ports/errors/tokens | CQ01/CQ05 are local exceptions to improve |
| Small process app | Config, bootstrap (`main.ts`), named runner and only necessary support modules | Keep; recovery's descriptive runner filename is intentional |
| Provider or core node | Domain directory with definition, schemas/validation and executor roles | Keep provider semantics local; do not flatten into generic utilities |
| Database capability | Capability directory; operation-specific persistence/transaction files | Keep authority and transaction ownership local |
| Larger pure model/engine | Domain or version-specific modules, canonical parsing and small public operations | Retain grammar/state-machine order rather than forced miniature files |
| Tests | Behavior-named tests plus explicit support/testing entrypoints | Add missing seam regressions, not one test file per source file mechanically |

No repository-wide rename of `types.ts`, `ports.ts`, `module.ts`, `config.ts`,
`server.ts` or `index.ts` is warranted: their directory/entrypoint role supplies
meaning. Short names become a problem when they collect unrelated behavior, as
CQ01 does. `service.ts` for a cohesive feature and `use-cases.ts` for multiple
operation classes are not automatically inconsistent abstractions.

Repeated checks were assessed semantically, not deleted by appearance. Examples
to preserve include workspace permissions versus RLS, executor entry validation
versus registry parsing, connection currency at dispatch versus initial lookup,
and post-await abort checks versus request-entry checks. Tiny identity helpers,
provider-specific error mapping and result-specific maintenance loops are not
automatically valuable abstraction opportunities.

The architecture guidance therefore influenced this assessment toward **local
ownership and behavior-tested seams**, not a new framework, universal repository,
shared “utils” package, rewritten state machine, or reopened ADR. The first coding
quality improvements are CQ02's test gap and CQ03's duplicated policy; CQ01/CQ04
are focused locality improvements and CQ05 is lower-impact consistency work.
The P1/P2 correctness findings remain higher remediation priorities.

## Verification for the expanded coding-quality pass

- A read-only ESLint diagnostic scanned **610 production TypeScript files** across
  all 18 parts, retaining the repository rules and adding `no-unreachable`,
  `no-else-return`, `no-lonely-if` and `no-useless-return`: **0 errors, 0 warnings**.
  Existing type-aware unnecessary-condition/assertion and constant-condition rules
  also remained active. This is evidence against mechanically redundant control
  flow, not proof that every domain condition is necessary.
- Fresh `pnpm build`, `pnpm architecture:check` (15 assertions),
  `pnpm complexity:check` (2 assertions) and `pnpm duplication:check` (6 assertions)
  passed. The duplication baseline still contains 27 source groups/512 lines and
  4 test groups/203 lines; passing means reviewed debt has not grown, not zero debt.
- The preceding **2,201 package/app tests and 15 selected PostgreSQL tests** are
  retained evidence at the same source revision, not advertised as newly rerun
  for this documentation expansion. No extra live-service or destructive suite
  was required to change the report.
- Final `pnpm docs:check` passed: 13 assertions and 292 validated local links;
  focused Prettier validation passed. No source, configuration, migration, test,
  dependency or deployment fix is part of this work. A temporary visual companion
  illustrates CQ01/CQ03/CQ04; the findings and all 18 verdicts are recorded here,
  so this report does not depend on that temporary file.

## Earlier part-specific source review notes

All ledger rows include package manifests, TypeScript project references and
Vitest configuration, not only implementation files.

### Package foundations and execution

- `node-sdk`: JSON size/depth boundaries, definition release contracts,
  executable types and executor interfaces. No additional confirmed issue.
- `node-catalog`: registration conflicts, immutable definitions and locked
  resolution. No additional confirmed issue.
- `nodes-core`: every node definition and executor, input validation, failure
  classifications and registration. F02 arises when apps choose the checkpoint,
  not from the For Each definition itself.
- `workflow-model`: graph/schema validation, identity, mappings and expression
  evaluation worker boundaries. No additional confirmed issue.
- `workflow-engine`: compilation, executable/checkpoint versions, admission,
  transitions, retry/cancellation, branch scope and structured iteration. The
  selected coverage configuration includes 28 of 48 source files; its percentages
  are not whole-package coverage. Synthetic checkpoint corruption without a
  legitimate producer was not promoted into a security finding.

### I/O and shared contracts

- `artifact-store`: streams, bounded reads, direct uploads, replication,
  object-version purge, control-ledger immutability, configuration and cleanup.
  F04 requires coordination with API admission and database cleanup. AWS/MinIO
  integration fixtures were inspected but not executed; retained immutable test
  objects are not automatically classified as a cleanup defect.
  Non-blocking test hygiene: `test/control-ledger.integration.test.ts:179–217`
  allocates four raw S3 clients without an `afterAll` destroy hook. Explicit
  teardown would clarify ownership; no hung test run was reproduced, and this
  observation is not counted among the nine confirmed findings.
- `contracts`: request/response schemas, bounded inputs, contract generation and
  generated OpenAPI. Schema validity alone does not prove agreement with guards.
- `integrations`: HTTP/Slack/Resend request boundaries, cancellation, bounded
  payloads, provider error handling, credential isolation and network validation.
  F05 is the mismatch with the deployment egress contract.
- `observability`: error/log redaction, telemetry attribute bounds, metrics
  cardinality, startup/shutdown and abortable timers. F08 is independently
  reproduced with the actual logger.
- `queue`: transport configuration, queue/job contracts, deduplication and
  ownership-aware closing. Unit checks do not prove Redis outage recovery.
- `rate-limit`: validated key/configuration boundaries, Redis command behavior,
  fail behavior and ownership. No additional confirmed issue.

### Database

Production-source inspection covers platform pools/readiness/telemetry,
configuration and migration execution; tenant identity/session/workspace access;
workflow authoring/publication and release compatibility; connection persistence;
trigger projection, webhooks and schedules; execution acceptance, outbox/inbox,
coordinator and node-attempt stores, preview/failure-notification/reconciliation;
artifacts, retention, control ledger, workspace lifecycle and operator commands;
and typed schema definitions. All 84 SQL migrations were inspected for schema,
grants/RLS, transactional state transitions, leases/fences and retention behavior.
F01, F03 and F07 remain the confirmed findings attributable to this package.

Manual test-inspection coverage is **partial**, not 159/159. The explicitly
verified primary-reviewer subset contains 29 TS test/support files: all eight
files under `test/support/`; configuration; database runtime unit/integration;
PostgreSQL telemetry unit/integration; migration checksum, execution-mode,
execution-plan and runner tests; package contract; readiness and serving-readiness;
schema shape; RLS; tenant-context hygiene; workspace transaction engine;
retention transaction and cancellation. The queue-duplicate SQL fixture and
targeted retention-artifact interleaving coverage were also inspected. Additional
test inspection informed the delegated source review, but its complete file
ledger was not reliably reconciled, so the remaining 133 TS files are not
claimed as exhaustively reviewed. Passing all 245 unit tests and 24 selected
PostgreSQL integration tests is execution evidence, not a substitute for that
missing manual-coverage evidence.

### Maintenance apps

- `lifecycle-command`: timeout-versus-lease validation, readiness marker,
  partial-bootstrap cleanup, signal listeners, expected-abort classification,
  polling and aggregate cleanup errors. Tests exercise both source seams and
  compiled child-process behavior with external dependencies mocked.
- `operator-command`: all command variants, explicit mutation/dry-run material,
  role configuration, dispatch, cancellation and bounded cleanup. Table-driven
  runner coverage now exercises all ten command variants, null status,
  pre-abort, readiness and operation failures, cleanup timeout, and multiple
  cleanup failures.
- `recovery`: bounded inventory/pagination, region/principal separation,
  readiness ordering, reconciliation, replica verification, cancellation and
  cleanup. The app tests mock storage/database; no live restore was performed.
- `retention`: shared runtime ownership, eight independent maintenance loops,
  deduplicated readiness, failure backoff, replica monitoring, metrics and shutdown.
  Existing tests cover failure isolation/recovery, not real destructive-I/O
  interleavings. The shared abortable delay resolves on cancellation; ordinary
  shutdown supervision awaits pending operations. No additional shutdown defect
  was confirmed.

### API

Reviewed all feature controllers/services/guards, Nest module boundaries,
runtime composition, HTTP errors and limits, sessions/CSRF/workspace permissions,
workflow publication/execution admission, SSE, artifacts, connections, webhook
ingress/management, schedules, previews and lifecycle endpoints. The original
F02/F04/F05/F06/F09 gaps are resolved by the implementation above.
API unit/HTTP-injection tests are not live database/Redis integration, compatibility
rollout, or SSE resilience evidence; those separate suites were inspected but
not freshly run during this pass.

### Worker

All production configuration, Nest composition, execution engines/handlers and
runtimes, provider capabilities/telemetry, transport dispatch and consumers,
trigger supervision, readiness, resource monitoring and process lifecycle were
reviewed. Tests cover identity/checksum binding, claims/fences, outcomes and
dispatch ambiguity, capability cleanup, bounded artifacts, preview deadlines,
failure notifications, lease renewal, retry/drain behavior and compiled-process
signals. The review includes 16 support TS files, 21 integration/resilience TS
files, remaining unit/fixture TS files and related process/retained-workflow
fixtures. F02 is resolved by the API and worker selector regressions; no
additional confirmed worker finding was identified.

The retained executable fixture is checked against its graph, exact envelope,
checksum and executor identities. By contrast, For Each integration fixtures
that preselect V2 do not prove the production initial-checkpoint selector works.
The fresh 278-test run is the configured unit/process cohort; the separately
inspected destructive integration/resilience suites were not run.

## Remaining verification limits and suggested order

The review covers every package and app, plus the cross-cutting contracts cited
above; it does not claim every infrastructure tool received a new line-by-line
audit. The build, architecture, deployment, dependency and documentation gates
provide the additional repository-level evidence listed earlier.

The initial implementation pass did not rerun the full database integration,
Redis transport/outage or compatibility-rollout cohorts. Shared-service tests
can truncate fixtures, obliterate queues or stop PostgreSQL/Redis, so its fresh
integration selection used disposable local PostgreSQL fixtures instead. The
local verification closeout below supersedes that execution gap. Real AWS
policy, Object Lock and regional restore qualification remain external; no
production environment, external provider, grant or cloud configuration was
modified.

The suggested implementation order was followed: F01/F02 first, F03/F04 as one
artifact-lifetime protocol, then the remaining owning boundaries and CQ items.
The resolution table and final verification record supersede the original open
status while preserving the original correction rationale below.

## Final implementation verification

Fresh post-implementation checks on 2026-09-08:

| Check | Result |
| --- | --- |
| `pnpm build` | Passed |
| `pnpm typecheck` | Passed across all 18 workspace projects |
| `pnpm lint` and `pnpm format:check` | Passed |
| `pnpm test` | Passed; 2,232 tests across all configured package/app unit cohorts, including focused lock-cancellation, migration-backfill, and startup-cleanup regressions |
| Selected database integration set | Passed; 9 files / 24 tests covering lifecycle locks, upload/retention races, preview deletion, schema ACLs, capacity scheduling, workspace purge and prior-head migrations |
| `pnpm contracts:check` | Passed; generated artifacts are current, all eight OpenAPI documents validate, 38 contract tests pass |
| `pnpm deployment:check` | Passed; 29 assertions plus runtime typecheck, deterministic render and deployment validators |
| `pnpm architecture:check` | Passed; 15 assertions and both graph validators |
| `pnpm database:schema:check` | Passed; all 68 migration-owned application tables accounted for |
| `pnpm dependencies:check` | Passed |
| `pnpm complexity:check` | Passed after refreshing the reviewed hotspot inventory; CQ01 removed the former 575-line connection use-case hotspot, while the lifecycle lock protocol deliberately extends existing database hotspots |
| `pnpm duplication:check` | Passed; 29 source groups / 527 lines and 4 test groups / 203 lines, with the lifecycle locking, separate trigger contracts, and provider outcome unions explicitly reviewed |

### Local integration and migration closeout

Fresh local verification on 2026-09-08 used Compose project
`pertexo-local-verify-20260908` with new disposable volumes and non-default host
ports: PostgreSQL 18 on `25432`, Redis 8.2.8 on `26379`, S3Mock 5.1 on `29090`,
and independent primary/recovery MinIO processes on `29091`/`29092`. The worker
tests' intentional PostgreSQL/Redis stops and BullMQ obliteration therefore
targeted only this project. The fixture project and its volumes were removed
after verification; the default development project was not used.

| Check | Result |
| --- | --- |
| `pnpm build` | Passed before the real-service matrix |
| `pnpm --filter @pertexo/database typecheck` | Passed with the new prior-head test |
| `pnpm exec eslint packages/database/test/artifact-finalization-retention-deadline-migration.integration.test.ts` | Passed |
| Focused `vitest.integration.config.ts` run of `artifact-finalization-retention-deadline-migration.integration.test.ts` | Passed; 1 file / 1 test. The real migration runner upgraded a populated exact-`0082` database. Two short available user uploads in different workspaces became `finalized_at + 30 days`; a longer deadline, a pending upload and an unrelated available artifact retained their deadlines and update timestamps. The test first proved `app.artifacts` had enabled and forced RLS and that `pertexo_owner` had no `BYPASSRLS`, then read each workspace through the scoped API role. |
| `pnpm test:integration` with every local service gate enabled, including compatibility rollout | Passed; artifact-store 2 files / 5 passed / 3 skipped, queue 1 / 1, database 77 / 394, worker 20 / 30, API 9 / 33: **109 files / 463 passing tests**, with no unexpected skip or todo |

The first full-matrix invocation omitted the four local MinIO administrator
variables. Its artifact-store stage therefore stopped with
`Control ledger integration admin credentials are required` after 3 S3Mock
tests passed and 5 ledger tests were skipped. After matching the repository's
existing CI environment contract, the complete command passed with the counts
above. This was a local harness invocation error, not a product-code failure.

The three remaining skips are the AWS-only control-ledger cases: the exact
dual-service append/replay/conflict/repair path and immutable conditional-create
policy enforcement in each of the primary and recovery regions. MinIO explicitly
cannot implement the required `s3:if-none-match` bucket-policy condition. These
skips are not counted as passes and neither S3Mock nor MinIO is treated as AWS,
Object Lock, regional-isolation or restore evidence. No paid or live resource
was created or changed.

An independent rerun on 2026-09-08 reproduced all **463 passes across 109
files** and the same **3 AWS-only skips**. It used a separate Compose project,
`pertexo-independent-verify-20260908`, with fresh volumes and ports `35432`,
`36379`, `39090`, `39091` and `39092`. The environment followed the checked-in
CI contract with local endpoints and compatibility-rollout and SSE-resilience
gates enabled. `pnpm build`, database test typecheck, focused test ESLint and
Prettier checks, and `pnpm docs:check` also passed. The database cohort included
the populated `0082` to `0083` regression. The independent fixture containers,
network and volumes were removed afterward without changing the default
development project. This confirms local execution evidence only; the live
Phase 7 qualifications above remain deferred.

## Source inventory baseline

Counts are inventory, not a claim that every file has already been reviewed.
Production means `.ts` files beneath `src/`; test/support means `.ts` files
beneath `test/`. Generated `dist/`, dependencies, caches, and coverage outputs
are excluded. Manifest, TypeScript, test-runner, and contract-generator
configuration are reviewed separately from those counts.

| Part | Production files | SQL migrations | Test/support files |
| --- | ---: | ---: | ---: |
| `packages/artifact-store` | 15 | 0 | 13 |
| `packages/contracts` | 23 | 0 | 8 |
| `packages/database` | 168 | 84 | 162 |
| `packages/integrations` | 32 | 0 | 9 |
| `packages/node-catalog` | 5 | 0 | 5 |
| `packages/node-sdk` | 10 | 0 | 2 |
| `packages/nodes-core` | 57 | 0 | 7 |
| `packages/observability` | 11 | 0 | 11 |
| `packages/queue` | 12 | 0 | 12 |
| `packages/rate-limit` | 4 | 0 | 3 |
| `packages/workflow-engine` | 48 | 0 | 28 |
| `packages/workflow-model` | 22 | 0 | 9 |
| `apps/api` | 138 | 0 | 86 |
| `apps/lifecycle-command` | 4 | 0 | 6 |
| `apps/operator-command` | 3 | 0 | 2 |
| `apps/recovery` | 3 | 0 | 2 |
| `apps/retention` | 5 | 0 | 3 |
| `apps/worker` | 54 | 0 | 73 |
