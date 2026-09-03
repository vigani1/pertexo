# Code Implementation Craft Audit

Recorded: 2026-09-03

Audited implementation tree: `475d499f448d41aeb550c4236af7abf63d349868`

Status: current read-only findings and refactoring guidance

## 1. Purpose

This audit reviews implementation craft rather than re-deciding the system
architecture. It asks whether an experienced senior or staff TypeScript backend
engineer, working from the same architecture and requirements, would implement
the repository in approximately this form.

The review concentrates on:

- function and method clarity;
- file and folder organization;
- behavioral duplication;
- redundant validation and defensive code;
- missing and unnecessary abstractions;
- TypeScript modeling;
- request and job data flow;
- error handling;
- dependency and lifecycle composition;
- realistic code-level performance;
- naming, comments, and cross-repository consistency; and
- code that looks complicated but must remain explicit for correctness.

Architecture, distributed correctness, security, CI, coverage, and production
readiness remain covered by [the whole-repository audit](./whole-repository-audit.md).

## 2. Review coverage and limitations

This was a repository-wide, risk-based implementation review. It was not a
manual line-by-line inspection of every production line.

Every production file was included in repository-wide inventories and searches
for size, function complexity, imports, package dependencies, unsafe TypeScript
constructs, validation calls, error classes, catch blocks, optional-property
construction, runtime freezing, timers, abort handling, transaction patterns,
and duplicated source. The entire workspace was also compiled, linted,
type-checked, and exercised by its normal non-integration test command.

Deep manual inspection then targeted:

- every measured high-complexity function and large source-file family;
- API controllers, guards, use cases, error mappers, request context, and
  application composition;
- worker composition, coordinator, node-attempt, preview, trigger, and outbox
  paths;
- database transaction ownership, row mapping, workflow publication, run
  acceptance, coordinator and attempt persistence, triggers, lifecycle,
  retention, purge, and recovery;
- workflow graph, executable, checkpoint, mapping, scheduling, and observation
  code;
- queue, secure HTTP, connection, provider, artifact, and rate-limit adapters;
  and
- representative unit, integration, resilience, and support-fixture styles.

Therefore this audit supports conclusions about repository-wide patterns and
the dominant risk areas. It does not claim that every one of the approximately
86,400 production lines received equal manual scrutiny, and it cannot guarantee
that no isolated local smell remains outside the sampled paths.

Verification at the audited tree:

- `pnpm check`: passed;
- formatting, documentation checks, runtime checks, builds, lint, complexity
  ratchet, generated-contract check, and TypeScript checks: passed;
- 1,529 non-integration tests: passed; and
- worktree before this document was created: clean.

The ordinary `pnpm check` does not run the separately configured PostgreSQL,
Redis, service, resilience, provider, load, or recovery-drill suites. A green
result here is characterization evidence, not proof of production readiness or
whole-repository behavioral coverage.

## 3. Executive verdict

The codebase is clean overall, well above the quality of a typical large
application repository, and recognizably senior-level TypeScript. It is not yet
as clean or consistent as it can reasonably be.

The dominant weakness is accumulated implementation ceremony: the same values
are sometimes parsed or authorized twice, error conversion and request metadata
adaptation repeat across controllers, lifecycle helpers have drifted, database
row parsing is inconsistent, dependency bags admit invalid combinations, and
large database/composition files concentrate too many reasons to change.

The package architecture is stronger than some of the implementations inside
the packages. The right refactoring direction is to preserve the existing deep
module interfaces while improving locality inside their implementations.

| Area | Assessment |
| --- | ---: |
| Overall implementation craft | 8.1/10 |
| Package-level organization | 8.7/10 |
| Internal file organization | 7.4/10 |
| Function readability | 7.8/10 |
| TypeScript quality | 8.5/10 |
| Runtime-boundary validation | 8.8/10 |
| Consistency | 7.5/10 |
| Error-handling cleanliness | 7.2/10 |
| Dependency/lifecycle composition | 7.0/10 |
| Testability | 8.8/10 |

Approximately **72% of the implementation complexity is intrinsic** to durable
workflow orchestration, leases, recovery, retention, external side effects,
uncertain outcomes, and security-sensitive boundaries. Approximately **28% is
implementation-created** and can be reduced without weakening the architecture.

Repository facts used for calibration:

- 448 production TypeScript files and approximately 86,429 source lines;
- 340 TypeScript test/support files and approximately 92,827 test lines;
- 45 production files above the repository's 500-line budget;
- 42 function hotspots above 200 lines or 40 branches;
- approximately 1.12% source duplication and 0.42% test duplication;
- no package dependency cycle;
- no generic `utils`, `common`, or `shared` dumping ground;
- no production `any`, `as unknown as`, non-null assertion,
  `@ts-ignore`, or `@ts-expect-error` escape hatch found; and
- 123 directly exported classes extending `Error`.

## 4. Relationship to the authoritative implementation plan

### 4.1 Overall conclusion

The code-craft audit and the implementation plan do not ask for contradictory
systems. The plan defines architecture, behavior, ownership, durability, and a
substantial amount of coding policy. This audit asks whether the implementation
expresses those decisions with minimum accidental complexity.

The architecture and the central runtime behavior are broadly aligned with the
plan. Several findings in this document are, however, implementation drift from
rules the plan already contains. They are not new preferences introduced after
the project was built.

Other findings are refinements that the plan did not specify. A plan cannot
reasonably prescribe every timer, mapper, local index, source-file split, or
cleanup helper. Those findings supplement the plan and do not supersede it.

The current relationship is:

- **broad architectural compliance:** strong;
- **behavioral/vertical-slice compliance:** strong for implemented phases,
  subject to the open findings in the whole-repository audit;
- **coding-rule compliance:** good but incomplete; and
- **production/Phase 7 compliance:** incomplete, as already recorded by the
  whole-repository audit and implementation tracker.

### 4.2 Direct plan alignment and drift

| Plan requirement | Current assessment | Relevant audit finding |
| --- | --- | --- |
| Parse once at the owning seam | Partial drift | Some request values are parsed in both controller and use case; response and graph values also cross more parsing steps than necessary |
| Do not duplicate Zod, decorator, and ad hoc validation | Partial drift | Route parsing uses both manual inspection and schemas; persisted rows use several validation styles |
| One global exception filter maps application errors | Partial drift | The shared problem filter exists, but controllers still repeat feature mapping catches around whole handlers |
| One authentication guard establishes the actor; module policy performs authorization | Partial drift | Feature capability guards authorize and then many use cases perform the same authorization lookup again |
| Avoid generic option bags and invalid combinations | Partial drift | API and worker composition dependency bags allow mutually shadowing runtime/override combinations |
| Transactions have one use-case owner rather than scattered repository transaction setup | Mostly aligned with one concrete drift | The shared tenant transaction implementation is strong, but failure notifications reimplement it locally |
| Helper extraction requires shared semantics | Aligned | There is little text duplication and no generic helper bucket; this audit does not recommend broad DRY refactoring |
| Functions do one job and comments explain constraints | Mostly aligned | Most long correctness flows are cohesive; the workflow draft catch/rethrow is one clear counterexample |
| One application error structure rather than a subclass per application case | Partial drift | `ApplicationError` is used at the HTTP seam, but tag-only error subclasses and `instanceof` mapping ladders remain numerous |
| Strict TypeScript and minimal unsafe assertions | Strongly aligned | Strict project references and production escape-hatch avoidance are notable strengths |
| Discriminated unions and exhaustive handling | Strongly aligned | Execution outcomes and domain variants generally follow this pattern |
| Capability-oriented folders and explicit ownership | Top-level aligned; internal convergence incomplete | API features and packages are clear, but the database package remains a 104-file flat directory |
| Static package direction and server-only export protection | Strongly aligned, with one manifest defect | Package graph is acyclic and imports are disciplined; worker runtime dependency classification is incorrect |
| Graceful shutdown and named timeout ownership | Partial drift | Worker keepalive ownership, lifecycle-helper variation, and non-canceling publish timeouts remain |
| Tests target public module interfaces | Strongly aligned | Unit and integration styles generally test meaningful interfaces rather than private Nest internals |

### 4.3 Areas where the plan was not detailed enough

The plan is not fundamentally lacking, but it did not define a canonical policy
for every implementation concern uncovered here:

- cleanup error aggregation and preservation of primary versus cleanup errors;
- timer and abort-listener ownership;
- validation of emitted runtime imports against production dependency manifests;
- one persisted-row parsing convention for ordinary SQL projections;
- when runtime `Object.freeze` is valuable versus ceremonial;
- how test overrides and production runtime dependencies form valid composition
  variants;
- local algorithmic indexing for maximum-size workflow graphs; and
- a concrete migration strategy for breaking up large implementation files
  without widening public interfaces.

These should be treated as implementation guidance or repository standards,
not new architecture requirements. If made normative, they can be added to a
short coding-standard document or the relevant operations guidance rather than
making the architecture plan even larger.

### 4.4 Areas that only appear contradictory

- The plan requires defensive validation at external, persisted, and queue
  seams. This audit does not recommend removing those checks. It recommends
  removing repeated checks after one seam has already established trust.
- The plan requires explicit correctness sequencing. This audit does not
  recommend shortening coordinator, lease, fence, webhook, retention, or
  recovery flows merely to reduce line counts.
- The plan discourages speculative abstractions. This audit recommends only
  narrow abstractions with demonstrated repeated semantics, such as tenant
  transaction ownership and abortable delays.
- The plan favors small, capability-oriented modules but also warns against
  empty layers. The proposed source reorganization preserves aggregate public
  interfaces and splits only implementations with multiple reasons to change.

## 5. Top 20 implementation-quality findings

### C-01 — Bounded operations do not cancel the underlying publication

- **Severity:** high.
- **Locations:** `apps/worker/src/transport/outbox-dispatcher.ts#bounded` and
  `packages/queue/src/producer.ts#withTimeout`.
- **Issue:** the timeout rejects the caller while the publication operation
  continues in the background.
- **Why it matters:** a caller can observe failure even though the message is
  later published. This is an unknown outcome, not a normal failed operation.
- **Cleaner shape:** pass an `AbortSignal` into an actually cancellable adapter,
  or return an explicit timed-out/unknown-outcome result owned by the transport
  module.
- **Behavior change:** yes; timeout and retry semantics become explicit.
- **Refactor risk:** high because idempotency and redelivery must remain truthful.
- **Plan relationship:** direct refinement of the plan's first-class
  `outcome_unknown` requirement; current behavior is incomplete.

### C-02 — Failure notification storage reimplements tenant transactions

- **Severity:** high.
- **Remediation status:** complete on 2026-09-03.
- **Repository-wide affected locations:** the only owner-local tenant
  transaction helpers duplicating the ordinary request/store transaction were
  `transaction` and `abortableTransaction` in
  `packages/database/src/failure-notifications.ts`; their four call sites own
  claim, destination load, dispatch fencing, and completion. A repository-wide
  `begin`/workspace-context inventory also covered dispatcher, migrations,
  compatibility maintenance, preview and artifact retention, lifecycle and
  operator commands, control-ledger coordination, workspace purge, and general
  retention. Those occurrences remain intentionally specialized: they are
  platform-global/owner-role transactions, cross-workspace maintenance that
  changes tenant context inside a bounded step, or operational flows with
  explicit lock/statement timeouts and cancellation sequencing. They are not
  interchangeable ordinary tenant-store transactions.
- **Remediation:** removed both failure-notification helpers and routed all four
  call sites through `withTenantScopedClient`. Extended the canonical primitive
  with a validated transaction-local `statementTimeoutMillis` option and
  fail-closed read-back, preserving the destination load's 30-second bound
  while gaining context preflight, rollback aggregation, and contaminated-client
  destruction.
- **Verification:** red/green timeout installation and mismatch tests in
  `packages/database/test/workspace-transaction-engine.test.ts`; focused suite
  21 tests, complete database unit suite 170 tests, database typecheck and build.
  The existing real-adapter cancellation characterization in
  `tenant-context-hygiene.integration.test.ts` was invoked but could not run
  because no PostgreSQL service was listening on `127.0.0.1` or `::1` port
  5432; it was not reported as passing.
- **Location:** `packages/database/src/failure-notifications.ts#transaction` and
  `#abortableTransaction`.
- **Issue:** the module manually acquires clients, starts transactions, installs
  workspace context, handles abortion, rolls back, and releases connections.
- **Why it matters:** it bypasses the stronger hygiene in
  `packages/database/src/workspace.ts#runTransaction`, including context
  preflight, setting read-back, rollback aggregation, and contaminated-client
  destruction.
- **Cleaner shape:** extend the canonical tenant transaction primitive with the
  required statement-timeout behavior and use that one implementation.
- **Behavior change:** intended success behavior does not change; failure
  behavior becomes safer and more consistent.
- **Refactor risk:** medium because forced cancellation requires integration
  characterization.
- **Plan relationship:** implementation drift from centralized transaction
  ownership and tenant-context rules.

### C-03 — Worker keepalive has no lifecycle owner

- **Severity:** high.
- **Remediation status:** complete on 2026-09-03.
- **Repository-wide affected locations:** the discarded interval in
  `apps/worker/src/main.ts` was the only unowned production interval. The
  intervals in `WorkerResourceMonitor`, `WorkerReadinessMonitor`, and database
  PostgreSQL telemetry already retain handles, unreference background sampling,
  and clear on shutdown. Remaining production timeouts are bounded operation
  deadlines or awaited delays rather than process-lifetime resources; their
  cancellation behavior is assessed separately by C-01 and C-06.
- **Remediation:** moved the intentionally referenced fallback keepalive into
  `WorkerProcessKeepalive`, a Nest lifecycle provider that creates the timer on
  application bootstrap and clears it before shutdown. Its referenced behavior
  is retained so a worker with every dispatch capability disabled remains alive.
- **Verification:** red/green lifecycle regression in
  `apps/worker/test/worker-process-keepalive.test.ts`; `pnpm --filter
  @pertexo/worker exec vitest run test/worker-process-keepalive.test.ts
  test/worker-bootstrap.test.ts` (15 tests).
- **Location:** `apps/worker/src/main.ts#bootstrap`.
- **Issue:** the worker creates a `setInterval` and discards its handle.
- **Why it matters:** the interval can retain the process and cannot be cleared
  during application shutdown.
- **Cleaner shape:** make it an owned closeable resource, or call `unref()` if
  it is not intended to keep the process alive.
- **Behavior change:** shutdown behavior only.
- **Refactor risk:** low.
- **Plan relationship:** direct drift from graceful-shutdown requirements.

### C-04 — A worker runtime dependency is development-only

- **Severity:** high.
- **Remediation status:** complete on 2026-09-03.
- **Repository-wide affected locations:** runtime imports occur in
  `apps/worker/src/execution/failure-notification-delivery.ts` and
  `apps/worker/src/execution/failure-notification-handler.ts`; the incorrect
  declaration was in `apps/worker/package.json` and its importer snapshot in
  `pnpm-lock.yaml`. An AST inventory of production imports for all 19 workspace
  projects found no other runtime package that was missing from `dependencies`.
- **Remediation:** moved `@pertexo/workflow-model` from worker
  `devDependencies` to `dependencies`. Both imports are intentionally retained:
  they use the workflow-model package's canonical failure-notification contract
  and exhaustive assertion at runtime.
- **Verification:** `pnpm --filter @pertexo/worker build`; isolated
  `pnpm --filter @pertexo/worker deploy --legacy --prod <temporary-directory>`
  and verified that the deployed production tree contains
  `@pertexo/workflow-model`.
- **Locations:** `apps/worker/src/execution/failure-notification-delivery.ts`
  and `apps/worker/package.json`.
- **Issue:** emitted runtime code imports `@pertexo/workflow-model/assert-never`,
  but the package is declared only in `devDependencies`.
- **Why it matters:** an isolated production install can omit a required module
  even though monorepo build and tests pass.
- **Cleaner shape:** declare the runtime package in `dependencies`, or use a
  genuinely owner-local exhaustive helper.
- **Behavior change:** none.
- **Refactor risk:** low.
- **Plan relationship:** direct package-manifest compliance defect.

### C-05 — Workspace authorization is repeated on guarded requests

- **Severity:** medium.
- **Remediation status:** complete on 2026-09-03.
- **Repository-wide affected locations:** the duplicate guarded path covered
  seven workflow-authoring operations, four workflow-run operations, four
  connection operations, two node-testing operations, and three workspace
  lifecycle operations. Schedule, webhook, and failure-notification destination
  controllers use capability guards but their use cases did not repeat the
  lookup. Direct use-case callers without a guard context intentionally retain
  authorization. Connection testing intentionally retains one fresh
  `connection:use` lookup immediately before credential decryption/provider
  dispatch, and node testing retains the distinct `connection:use` capability
  check for graphs with connection references.
- **Remediation:** `WorkspaceAuthorizationSource` is now owned and exported by
  the workspace authorization module; no derived `Parameters` form remains.
  Guard-issued authorization contexts have provenance tracking and must match
  capability, workspace, actor, session, request, and trace identity before a
  use case can reuse them. Guarded controllers pass that context and its exact
  actor/request identity to use cases, eliminating the repeated access query
  without accepting a fabricated request property or weakening tenant/RLS
  persistence checks.
- **Verification:** red/green provenance, mismatch, and no-second-lookup tests;
  feature tests cover the deliberately retained credential checks; complete API
  suite 381 tests, API typecheck and build, plus repository lint.
- **Locations:** `apps/api/src/identity-workspace/guards.ts`, workflow authoring,
  workflow run, and connection use cases.
- **Issue:** the capability guard calls `authorizeWorkspace`, stores the
  authorized context, and the use case commonly performs the same access lookup
  again.
- **Why it matters:** it adds a database round trip and leaves the owning trust
  seam unclear.
- **Cleaner shape:** establish one `AuthorizedWorkspaceContext` at the
  application seam and pass it to the use case. Retain transactional/RLS checks
  required for atomic correctness.
- **Behavior change:** potentially, because membership can change between
  checks.
- **Refactor risk:** medium; security-sensitive tests are mandatory.
- **Plan relationship:** drift from the plan's authentication-guard and module-
  authorization split.

### C-06 — Abortable delay implementations have drifted

- **Severity:** medium.
- **Remediation status:** complete on 2026-09-03.
- **Repository-wide affected locations:** duplicated delays existed in the
  coordinator runtime, trigger runtime, durable node-attempt heartbeat, preview
  node-attempt heartbeat, and the preview-maintenance recovery loop (the fifth
  location was not named in the original examples). The failure-notification
  handler's combined queue-abort/deadline controller is intentionally retained:
  it owns different timeout semantics and already removes its listener in
  `finally`. Queue execution, expression evaluation, API streaming/OIDC, object
  storage, and database cancellation listeners likewise govern in-flight I/O
  rather than worker loop delays and retain their local cleanup contracts.
- **Remediation:** introduced worker-owned `waitForSupervisorDelay` (abort
  resolves a loop wait) and `waitForAbortableDelay` (abort rejects operational
  work with `AbortError`). Both remove the listener on elapsed completion,
  clear the timer on abort, and close the registration race. All five duplicate
  worker delay implementations now use one of these explicit semantics.
- **Verification:** red/green timer and listener regression tests in
  `apps/worker/test/abortable-delay.test.ts`; targeted trigger, coordinator,
  durable attempt, preview attempt, and preview reconciliation suites plus the
  delay suite (67 tests); worker typecheck. A post-change worker source scan
  found no remaining timer-backed abortable delay outside the shared primitive.
- **Locations:** worker coordinator runtime, trigger runtime, node-attempt
  handler, and preview-attempt handler.
- **Issue:** four similar helpers differ in resolve/reject behavior and listener
  cleanup. The trigger delay leaves its abort listener installed when the timer
  completes.
- **Why it matters:** long-lived supervisor signals accumulate listeners and
  semantically similar loops behave differently.
- **Cleaner shape:** one worker-owned delay interface with explicit resolve-on-
  abort and reject-on-abort operations, or two separately named primitives.
- **Behavior change:** no intended change.
- **Refactor risk:** low.
- **Plan relationship:** plan refinement.

### C-07 — Native webhook replies are detached

- **Severity:** medium.
- **Remediation status:** complete on 2026-09-03.
- **Repository-wide affected locations:** the webhook ingress success response
  and its `problem` helper were the only production Fastify reply sends whose
  thenable was explicitly discarded. Repository-wide detached `.send()` and
  reply-chain searches found no other occurrence. The synchronous
  `ProblemDetailsFilter` response write is intentionally adapter-shaped around
  both Fastify and Express response interfaces and is not a detached promise.
- **Remediation:** all native webhook success, authentication, validation,
  admission, and scoped-error responses now await the Fastify reply. The
  authentication and problem helpers return `Promise<void>`, and the scoped
  error handler awaits the same response boundary.
- **Verification:** red/green-style response-failure characterization routes a
  simulated accepted-response serialization failure through the scoped safe
  503 handler; focused webhook ingress suite (12 tests), API typecheck.
- **Location:** `apps/api/src/webhooks/ingress.ts#acceptWebhook` and `#problem`.
- **Issue:** `void reply.code(...).send(...)` discards the reply promise.
- **Why it matters:** serialization and transport failures do not propagate
  through the request handler.
- **Cleaner shape:** return or await the Fastify reply and let `problem` return
  the reply rather than `undefined`.
- **Behavior change:** error propagation improves.
- **Refactor risk:** medium because exact response timing should be tested.
- **Plan relationship:** implementation defect within the existing API design.

### C-08 — Redis rate limiting lacks a wall-clock deadline

- **Severity:** medium.
- **Remediation status:** complete on 2026-09-03.
- **Repository-wide affected locations:** production Redis construction and
  operation waits were inspected across `packages/rate-limit`,
  `packages/queue`, and the API run-event source. Queue publication and
  run-event notification/source adapters already own bounded waits; the only
  request-facing rate-limit gap was
  `packages/rate-limit/src/redis-runtime.ts#RedisRateLimitRuntime`.
- **Remediation:** the rate-limit adapter now applies one validated 100–10,000
  ms operation budget (1,000 ms by default) to connection establishment and
  Lua evaluation, disables reconnect retries, and disconnects/reset its lazy
  connection after a deadline so a later request can recover cleanly. A Lua
  command that completed just as the client timed out may conservatively have
  consumed capacity; callers never treat that unknown outcome as permission.
  ADR-012's caller-owned policy remains explicit: safe authenticated reads
  fail open and mutation/side-effect classes fail closed.
- **Verification:** `@pertexo/rate-limit` unit suite (12 tests), focused API
  rate-limit interceptor suite (10 tests), package build/typecheck/lint, API
  typecheck, complexity ratchet, and documentation checks.
- **Location:** `packages/rate-limit/src/redis-runtime.ts#RedisRateLimitRuntime`.
- **Issue:** retries are bounded, but connection and command waits have no
  explicit end-to-end deadline.
- **Why it matters:** degraded Redis can retain an API request beyond its
  intended budget.
- **Cleaner shape:** give the adapter one bounded connection/command policy and
  make fail-open or fail-closed behavior explicit at the caller seam.
- **Behavior change:** yes, during infrastructure degradation.
- **Refactor risk:** medium.
- **Plan relationship:** the plan requires owned timeouts; this is incomplete
  implementation rather than a contradictory request.

### C-09 — API composition types permit contradictory combinations

- **Severity:** medium.
- **Location:** `apps/api/src/app.ts#ApiApplicationDependencies`.
- **Issue:** callers can provide both a runtime and its overrides, or related
  persistence/runtime combinations whose precedence is implicit.
- **Why it matters:** the interface permits states the implementation silently
  ignores.
- **Cleaner shape:** use discriminated runtime sources such as
  `{ kind: 'provided', runtime }` and `{ kind: 'create', overrides }`, or move
  broad test substitution into a dedicated application test builder.
- **Behavior change:** only invalid combinations become explicit errors.
- **Refactor risk:** medium.
- **Plan relationship:** drift from the plan's instruction to avoid generic
  option bags and make invalid states difficult to represent.

### C-10 — Worker transport composition owns too much in one file

- **Severity:** medium.
- **Remediation status:** complete on 2026-09-03.
- **Repository-wide affected locations:** the 607-line transport module was the
  only worker Nest composition file that constructed all transport runtimes,
  dispatch registration, metrics, and shutdown ownership together.
  `worker.module.ts` remains a small application-module assembly point, while
  execution runtime factories remain capability implementations rather than
  Nest provider composition and are assessed independently.
- **Remediation:** retained `TransportModule` and every exported token/provider
  contract, but reduced the module to a 71-line assembly facade. Private source
  owners now separately compose coordinator, node-attempt, preview-maintenance
  and notification delivery, trigger runtime, dispatch/metrics/capability
  providers, lifecycle shutdown, and tokens/dependency types. Enablement rules,
  provider order, exports, failure cleanup, and shutdown order are unchanged.
- **Verification:** pre-change and post-change worker bootstrap characterization
  (14 tests); focused transport/dispatcher suites (40 tests); complete worker
  unit suite 255 tests; worker typecheck and build; repository lint and
  complexity ratchet.
- **Location:** `apps/worker/src/transport/transport.module.ts`.
- **Issue:** the 607-line implementation constructs coordinator, node attempt,
  preview maintenance, triggers, transport metrics, notification delivery,
  capability registration, outbox dispatch, and shutdown ordering.
- **Why it matters:** changes to one runtime require understanding unrelated
  enablement and resource ownership.
- **Cleaner shape:** retain one public Nest module but move private provider
  builders into owner-named source files.
- **Behavior change:** none.
- **Refactor risk:** medium.
- **Plan relationship:** source-level convergence issue, not an architectural
  contradiction.

### C-11 — Database factories act as large source-level namespaces

- **Severity:** medium.
- **Locations:** `createIdentityWorkspaceDatabase`,
  `createWorkflowAuthoringDatabase`, `createOperatorCommandDatabase`, and
  `createFailureNotificationStore`.
- **Issue:** large factories contain many nested commands, queries, SQL flows,
  mappers, and error policies. Their top-level complexity measurements hide the
  nested responsibility count.
- **Why it matters:** callers receive useful deep interfaces, but maintainers
  have poor locality inside the implementation.
- **Cleaner shape:** preserve the aggregate public interface and split the
  internal implementation by capability or operation family.
- **Behavior change:** none.
- **Refactor risk:** medium.
- **Plan relationship:** the plan explicitly says the source layout should
  converge on capability-oriented folders.

### C-12 — Persisted-row parsing is inconsistent

- **Severity:** medium.
- **Remediation status:** complete on 2026-09-03.
- **Repository-wide affected locations:** the weak mapper pattern covered
  workflow, draft, and version rows; user, authentication identity, session,
  workspace, and lifecycle-operation rows; the outbox claim JSON envelope; and
  isolated retention, node-attempt, run-event, cancellation, and OIDC date or
  digest fields. Workflow-trigger health already parsed every field with Zod.
  Remaining numeric conversions in control-ledger inventory, coordinator fact
  accounting, node-attempt fencing, and transaction-timeout read-back are
  immediately guarded by safe-integer/range or exact-identity checks. Ledger
  timestamps retained as `Date` construction immediately call `toISOString`,
  which rejects invalid values while preserving their comparison semantics.
- **Remediation:** added strict owner-local row schemas for workflow authoring,
  identity/workspace, and outbox claim envelopes; SQL now projects the exact
  outbox fields validated by that envelope. Replaced permissive string/number
  coercion and unchecked dates with UUID/enumeration/bounds/JSON/date schemas.
  Row parsing was extracted into private owner-named modules so the stronger
  boundary did not enlarge existing factory hotspots. Success-path domain
  shapes and the intentionally separate Phase 2 activation view are preserved.
- **Verification:** complete database unit suite 170 tests, database typecheck
  and build, API suite 381 tests, repository lint and complexity ratchet. Public
  identity/workspace and outbox PostgreSQL integration suites were invoked but
  could not run because no PostgreSQL service was listening on localhost port
  5432; they were not reported as passing.
- **Location:** `packages/database/src/workflow-authoring.ts#mapWorkflow`,
  `#mapDraft`, and `#mapVersion`.
- **Issue:** row fields are converted with `String`, `Number`, casts, and
  `new Date`. Invalid values can be coerced rather than rejected.
- **Why it matters:** a trusted domain record can be created from malformed
  persisted data without one explicit proof point.
- **Cleaner shape:** follow `packages/database/src/workflow-run-api.ts`: parse
  an unknown row through a strict file-owned schema, then map the parsed value.
- **Behavior change:** corrupt persisted rows fail earlier.
- **Refactor risk:** medium.
- **Plan relationship:** refinement of the plan's persisted-value seam rule.

### C-13 — Compatibility catalog construction repeats its projection

- **Severity:** medium.
- **Remediation status:** complete on 2026-09-03.
- **Repository-wide affected locations:** only
  `coreWorkflowCompatibility` built supported and placeable authoring catalogs
  from the same platform manifests. The workflow-engine admission mappings are
  intentionally different boundary catalogs used to validate an executable
  against its pinned release; the nodes-core successor mapping constructs a new
  release; node-catalog executor matching performs registry lookup. Database
  code consumes the two catalogs but does not reconstruct them.
- **Remediation:** active executor identities are indexed once, each executable
  definition manifest is projected and deeply frozen once, and supported and
  placeable catalogs are derived with named lifecycle predicates. Deprecated
  definitions remain supported for reads while only active definitions remain
  placeable.
- **Verification:** API typecheck and build; node-catalog suite (15 tests). The
  public PostgreSQL compatibility-rollout integration suite was invoked but
  skipped because its database test environment was unavailable; it remains the
  live characterization for deprecated-read/blocked-placement behavior and is
  included by the repository integration gate.
- **Location:** `apps/api/src/platform/workflow/workflow-runtime.module.ts`
  `#coreWorkflowCompatibility`.
- **Issue:** supported and placeable catalogs repeat executor matching,
  lifecycle filtering, integration mapping, array copying, and nested freezing.
- **Why it matters:** the meaningful policy difference—deprecated definitions
  remain readable but cannot be newly placed—is buried in duplicated mechanics.
- **Cleaner shape:** create one manifest projection, then derive supported and
  placeable views with named lifecycle predicates.
- **Behavior change:** none.
- **Refactor risk:** low to medium.
- **Plan relationship:** code-quality refinement consistent with compatibility
  requirements.

### C-14 — Controllers repeat whole-handler error plumbing

- **Severity:** medium.
- **Remediation status:** complete on 2026-09-03.
- **Repository-wide affected locations:** all controller-level catch clauses and
  feature error-mapper calls were inventoried across `apps/api/src`. Repetitive
  whole-handler translation was removed from workflow authoring, workflow run,
  node testing, connection, failure-notification destination, OIDC/session, and
  workspace controllers. The OIDC callback and workflow-run SSE catches remain
  because they detach cookies/listeners and abort work before rethrowing. Actor
  construction helpers retain narrow translation that deliberately creates a
  stable invalid-request error. Identity/workspace guard catches also remain:
  those guards protect schedule and webhook routes that have no owning feature
  mapper, so removing them demonstrably changed a known CSRF 403 into a 500.
- **Remediation:** `ProblemDetailsFilter` now accepts application-composed,
  route-aware feature mappers. `AppModule` owns the route-to-feature mapping,
  while each feature continues to own its existing error semantics. Specific
  routes are matched before the broader workflow and workspace families, which
  preserves distinct validation detail for otherwise identical `ZodError`
  values. Dead controller-only throw helpers were removed.
- **Verification:** red/green global-filter delegation characterization and a
  table covering connection, failure-notification, workflow-run, node-test,
  workflow-authoring, workspace, and identity route families; API suite (392
  tests), API typecheck and build. The guard inventory was additionally checked
  through API bootstrap, including the protected schedule-route CSRF response.
- **Locations:** workflow authoring, connection, failure-notification
  destination, identity/workspace, and related controllers.
- **Issue:** endpoint bodies are wrapped in `try/catch` primarily to invoke a
  feature error mapper.
- **Why it matters:** repetitive error mechanics dominate otherwise clear HTTP
  adaptation.
- **Cleaner shape:** use a global/filter composition that delegates to feature-
  owned error mappers. Do not create one universal domain-error package.
- **Behavior change:** none if response contracts are characterized.
- **Refactor risk:** medium.
- **Plan relationship:** direct drift from the one-global-exception-filter rule.

### C-15 — Draft saving contains a no-op catch/rethrow

- **Severity:** low.
- **Remediation status:** complete on 2026-09-03.
- **Repository-wide affected locations:** a structural scan of every production
  catch clause found this as the only branch whose possible paths all rethrew
  the same value without adding cleanup, translation, telemetry, or state
  repair. Catch/rethrow sites that perform those operations are intentionally
  retained.
- **Remediation:** removed the redundant catch from
  `SaveWorkflowDraftUseCase.execute` and moved the useful compare-and-swap
  snapshot constraint onto `WorkflowAuthoringDatabase.saveDraft`, the owning
  persistence interface. The use case still forwards the database conflict
  unchanged.
- **Verification:** the existing CAS snapshot characterization failed during an
  initially over-broad import cleanup and then passed after retaining the error
  type needed by the separate stale-request path; `pnpm --filter @pertexo/api
  exec vitest run test/workflow-authoring/use-cases.test.ts` (8 tests), API and
  database typechecks.
- **Location:** `apps/api/src/workflow-authoring/use-cases.ts`
  `#SaveWorkflowDraftUseCase.execute`.
- **Issue:** the catch checks `WorkflowRevisionConflictError` and then rethrows
  every possible error unchanged.
- **Why it matters:** it implies policy where none exists.
- **Cleaner shape:** remove the catch and place the valuable CAS explanation on
  the persistence interface or adapter.
- **Behavior change:** none.
- **Refactor risk:** low.
- **Plan relationship:** direct violation of the plan's function/comment craft
  guidance, but not a functional plan violation.

### C-16 — Some HTTP request values are parsed twice

- **Severity:** low.
- **Remediation status:** complete on 2026-09-03.
- **Repository-wide affected locations:** request-schema ownership was traced
  from every API controller into its invoked application/domain service. Real
  duplicate parsing covered workflow creation, workspace creation, connection
  creation/rotation/testing, OIDC callback completion, and node testing.
  Response schemas, persistence-row schemas, nested JSON decoding, cursor
  codecs, and graph/executable parsing remain because they validate different
  representations or separate trust boundaries rather than the same value.
- **Remediation:** workflow, workspace, and connection use cases now exclusively
  own their `unknown` command-body parsing and controllers forward the original
  body. The identity/workspace application service is the sole parser before
  handing a typed callback to the OIDC domain service. Node testing remains
  controller-owned because
  the controller must inspect the parsed mode to require idempotency and select
  HTTP 202, while its use-case input is explicitly the parsed contract type.
- **Verification:** added a public connection-use-case regression proving
  invalid unknown bodies fail before encryption or dispatch; API suite (394
  tests), API typecheck. A post-change schema-call inventory found one owning
  parse for each affected input flow.
- **Locations:** workflow creation controller and
  `CreateWorkflowUseCase.execute`; similar boundary choices occur elsewhere.
- **Issue:** the controller parses `workflowCreateRequestSchema`, extracts the
  name, and the use case reconstructs and parses the same schema again.
- **Why it matters:** the code does not communicate where the value becomes
  trusted.
- **Cleaner shape:** either pass `unknown` into an independently safe use case,
  or establish a parsed command at the HTTP seam and trust that typed command.
- **Behavior change:** none.
- **Refactor risk:** low.
- **Plan relationship:** direct drift from “parse once at the owning seam.”

### C-17 — Response validation and freezing are scattered

- **Severity:** low.
- **Remediation status:** complete on 2026-09-03.
- **Repository-wide affected locations:** response-schema parses and adjacent
  freezing were inventoried across API features. Workflow authoring was the
  only feature where one response family was assembled across use-case bodies
  and local record mappers. Identity/workspace, connection, workflow-run, and
  node-testing response parsers already have one final serializer per contract
  or one cohesive use-case response boundary and remain. Freezing of actor
  contexts, telemetry objects, runtime dependency objects, cryptographic
  results, and internal execution values is unrelated ownership and remains.
- **Remediation:** introduced the feature-private
  `workflow-authoring/serializers.ts` owner for list, create, draft, validation,
  publication, version, and versions contracts. Record conversion, graph
  parsing, ISO date conversion, final schema parsing, and representation-tag
  construction are now localized there; use cases only select data and invoke
  the appropriate serializer. Each public response contract is parsed once.
- **Verification:** workflow-authoring public use-case/controller suites (32
  tests), API typecheck. Post-change response-schema inventory confirms the
  workflow-authoring use-case module no longer constructs response contracts.
- **Locations:** workflow authoring `toDraft`, `toVersion`, and response
  construction; related API feature mappers.
- **Issue:** typed records are transformed, schema-parsed, and frequently
  shallow-frozen at individual call sites.
- **Why it matters:** public response validation is useful, but its ownership is
  unclear and large graph values can be traversed more than necessary.
- **Cleaner shape:** one serializer per response contract that performs the
  final parse exactly once.
- **Behavior change:** none.
- **Refactor risk:** low.
- **Plan relationship:** refinement of the existing response-contract rule.

### C-18 — Cursor and route parsing use multiple local styles

- **Severity:** low.
- **Remediation status:** complete on 2026-09-03.
- **Repository-wide affected locations:** the workflow collection route used a
  manual object/string check; schedule and webhook routes used non-strict local
  Zod objects; failure-notification destinations used one loose object with two
  optional identifiers and reparsed those identifiers; workflow and version
  cursors manually decoded JSON fields. Identity/workspace, connection,
  workflow-run, node-testing, and workflow-resource routes already use strict
  feature-owned schemas and are intentionally retained. Header preconditions
  and the numeric SSE event cursor have separate HTTP contracts and are not
  opaque pagination cursors.
- **Remediation:** all affected routes now use strict, readonly schemas with a
  distinct required shape for each route family. Workflow pagination now has
  one feature-private codec backed by a strict discriminated union for
  `workflow` and `versions` payloads; dates, UUIDs, positive version numbers,
  discriminator mismatches, and unknown fields are validated at decode.
- **Verification:** red/green public controller regression for unknown route
  fields and public use-case regressions for cursor strictness and round trips;
  targeted workflow-authoring, schedule, webhook, and failure-notification
  controller suites (46 tests); API typecheck; post-change search found no
  manual controller route object checks, loose route schemas, or second opaque
  cursor codec.
- **Locations:** workflow authoring cursor functions and controller route
  helpers.
- **Issue:** some routes use strict schemas, others manually inspect unknown
  objects, and cursor payloads manually parse JSON and fields.
- **Why it matters:** similar boundaries produce different code and potentially
  different error behavior.
- **Cleaner shape:** feature-private strict route schemas and discriminated
  cursor payload schemas with one codec per feature.
- **Behavior change:** invalid-input responses may become more consistent.
- **Refactor risk:** low.
- **Plan relationship:** partial drift from the single Zod-backed boundary rule.

### C-19 — Error classes are more granular than their policies require

- **Severity:** low to medium.
- **Locations:** database, queue, workflow, connection, trigger, artifact, and
  API feature error catalogs.
- **Issue:** 123 directly exported `Error` subclasses were found; many primarily
  act as `instanceof` tags.
- **Why it matters:** new expected outcomes can require another class, export,
  mapper branch, and test fixture across multiple layers.
- **Cleaner shape:** use one feature-owned coded error for simple expected
  failures and retain dedicated classes when they carry distinct evidence,
  causality, retry meaning, or rich fields.
- **Behavior change:** none intended.
- **Refactor risk:** medium because imports and tests may depend on class identity.
- **Plan relationship:** partial drift from the plan's application error
  taxonomy; many infrastructure/domain classes remain legitimate.

### C-20 — Executable graph validation repeatedly scans collections

- **Severity:** low to medium.
- **Remediation status:** complete on 2026-09-03.
- **Repository-wide affected locations:** collection lookup scans were
  inventoried across workflow-engine graph compilation, executable parsing,
  scheduling, checkpoint validation, and transition processing. The repeated
  graph-scale scans were confined to executable port and structured-branch
  validation. Checkpoint/invocation searches operate on distinct runtime state,
  preserve order-sensitive validation, or are outside graph publication and
  remain intentionally explicit. A final single pass selecting Merge nodes is
  not nested and remains clearer than materializing another public concept.
- **Remediation:** executable build and verification now each construct one
  private validation index containing nodes by ID, incoming edges by node and
  target port, outgoing edges by source port, paired Merges by Parallel ID, and
  adjacency. Port availability, configured branch outputs, pairing, exact
  Merge-input cardinality, branch roots, and reachability reuse that index;
  invariant checks and failure messages retain their original order.
- **Verification:** complete workflow-engine suite (224 tests) and typecheck;
  added a public `buildWorkflowExecutableV2` large-graph regression that
  compiles a 300-node chain within a two-second publication budget (the largest
  practical public fixture is also bounded by the executable's 10,000-member
  envelope limit). Post-change inspection found no node/edge `find`, `filter`,
  or `some` nested inside the two indexed validation loops.
- **Location:** `packages/workflow-engine/src/executable-workflow.ts`
  `#assertGraphPorts` and `#assertBranchesDoNotReconverge`.
- **Issue:** `find`, `filter`, and `some` operations repeatedly scan nodes and
  edges inside loops.
- **Why it matters:** the graph contract permits 1,000 nodes and 4,000 edges, so
  this is a realistic publication-time cost rather than a micro-optimization.
- **Cleaner shape:** construct one validation index containing nodes and
  incoming/outgoing edges by node and port, then run the same explicit checks.
- **Behavior change:** none.
- **Refactor risk:** medium because graph semantics are delicate.
- **Plan relationship:** plan refinement; it preserves all graph invariants.

## 6. File and folder structure

### 6.1 Structure that should remain

- The application/package separation and acyclic package graph.
- Feature-oriented API folders rather than global controller/service/repository
  buckets.
- Independent small process applications for recovery, retention, lifecycle,
  and operator commands.
- Separate workflow-model, workflow-engine, queue, integrations, node SDK,
  catalog, contracts, observability, rate-limit, artifact, and database owners.
- Existing coordinator and node-attempt database operation files; they should
  not be collapsed back into giant stores.
- Server/browser export-map separation.
- The absence of generic helper dumping grounds.

### 6.2 Structure that should be reorganized

`packages/database/src` has 104 TypeScript files in one directory. Prefixes
identify families, but the filesystem does not provide locality. A reasonable
target, without changing public export paths, is:

```text
packages/database/src/
  public/
    api.ts
    execution.ts
    lifecycle.ts
    maintenance.ts
    operator.ts
    recovery.ts
  tenant/
    workspace-transaction.ts
    workspace-access.ts
  authoring/
    records.ts
    row-schemas.ts
    draft-store.ts
    publication.ts
    previews.ts
  execution/
    acceptance/
    coordinator/
    node-attempt/
    run-api/
    unknown-outcome/
  triggers/
    webhook/
    schedule/
    projection/
  connections/
    management.ts
    resolution.ts
    secrets.ts
    testing.ts
  lifecycle/
    commands.ts
    purge.ts
    retention.ts
  compatibility/
    release.ts
    readiness.ts
```

Additional focused changes:

- move worker runtime provider construction under `transport/providers/`;
- extract API compatibility/catalog construction from
  `workflow-runtime.module.ts`;
- rename `phase3-checkpoint.ts` to a durable domain name such as
  `persisted-workflow-checkpoint.ts`, while preserving stored compatibility
  version names where they are externally meaningful; and
- split implementation portions of identity/workspace, workflow authoring,
  operator commands, failure notifications, retention, and purge behind their
  unchanged public interfaces.

## 7. Duplicate-pattern inventory

| Pattern | Main locations | Decision | Recommended owner |
| --- | --- | --- | --- |
| Tenant transaction lifecycle | Workspace transaction and failure notifications | Consolidate | Database tenant module |
| Abortable delays | Coordinator, trigger, node-attempt, preview-attempt runtimes | Consolidate shared semantics | Worker runtime |
| Shutdown `allSettled` handling | API runtimes, worker runtimes, transport module | Consolidate per application with explicit error policy | Owning application |
| Controller catch/map/rethrow | Workflow, connection, identity controllers | Replace with filter composition | API HTTP platform plus feature mapper |
| Actor/request/trace extraction | Workflow authoring, workflow runs, connections, node testing | Consolidate | API request-context adapter |
| Cursor encoding/decoding | Workflow and version listing | Small feature abstraction | Workflow authoring |
| Database row mapping | Multiple database capabilities | Converge on strict row schemas | Each database capability |
| Optional-property spreads | Approximately 160 production occurrences | Do not add a magic helper; repair selected interfaces | Owning interfaces |
| Response schema parsing | Approximately 20 API response sites | Keep validation; centralize serializers | Feature application layer |
| Timeout wrappers | Queue, outbox, OIDC, providers | Consolidate only inside each transport family | External adapter owner |
| Diagnostic error swallowing | Webhook and worker telemetry | Keep when semantic names differ; use owner-local recorder | Runtime owner |
| Idempotency hashing | Multiple command families | Keep domain-separated | Command owner |

## 8. Redundant and defensive guard inventory

| Candidate | Classification | Recommendation |
| --- | --- | --- |
| Guard authorization followed by identical use-case authorization | Redundant but security-sensitive | Establish one application authorized context; retain transactional checks |
| Transactional membership and RLS checks after HTTP authorization | Necessary defense-in-depth | Keep |
| Controller and use-case workflow-create parsing | Redundant but harmless | Parse once |
| Database input parsing after API parsing | Boundary validation | Keep because packages are independently callable |
| Response DTO parsing before returning HTTP results | Boundary validation | Keep, but centralize |
| Draft-save catch/rethrow | Harmful noise | Remove |
| Persisted checkpoint, executable, checksum, and version validation | Necessary defense-in-depth | Keep |
| Runtime presence checks caused by broad dependency bags | Hiding weak types | Replace invalid combinations in the type system |
| Manual route object checks beside route schemas | Inconsistent boundary validation | Standardize on strict schemas |
| Executor/definition compatibility checks during executable loading | Necessary persisted-artifact validation | Keep |
| Freeze of registries, constants, and durable cloned state | Useful invariant | Keep |
| Freeze of transient owner-local DTOs | Usually redundant | Remove only after mutation characterization |

## 9. Representative data-flow traces

| Path | Current flow | Main cleanup opportunity |
| --- | --- | --- |
| Workflow publish | Controller parsing, actor reconstruction, guard authorization, use-case authorization, draft parse/tag, database validation, locks, graph parse, compilation/checksum, row mapping, response schema | Remove duplicate authorization/parsing; preserve transactional publication and durable checks |
| Workflow run start | Request parse, authorization, command hashes, database input schema, published projection classification, checkpoint construction, acceptance/outbox, response schema | Name stable command/hash shapes; otherwise largely clean |
| Coordinator advancement | Queue delivery, handler, durable claim, executable/checkpoint parse, transition, observations, commit | Improve source locality; preserve explicit sequencing |
| Node attempt | Queue delivery, lease claim, input reconstruction, capability invocation, outcome classification, fenced completion | Consolidate heartbeat and cleanup mechanics only |
| HTTP integration | Invocation parse, executor config/input parse, secure HTTP parse, DNS/policy/redirect/body handling, output parse | Layered parsing is mostly valid because layers own different invariants |
| Preview execution | API acceptance, preview storage/outbox, worker claim, preview handler, completion/reconciliation | Share narrow timing/outcome primitives; do not merge preview and durable attempts wholesale |
| Webhook trigger | Raw headers, signature verification, secret selection, payload acceptance, checkpoint/outbox | Preserve linear security flow; fix detached replies |
| Schedule trigger | Scanner, fenced claim, run acceptance/outbox, reconciliation | Use canonical abortable loop helper |
| Workspace deletion | API lifecycle request, durable command, lifecycle worker, purge coordinator, external deletion, control ledger | Preserve order and fences |
| Retention | Supervisors, claim/page processing, policy checks, deletion and ledger updates | Split source for navigation, not semantic stages |
| Recovery | Readiness, ledger reconciliation, artifact inventory, replica verification, report | Clear and appropriately linear |

## 10. Complexity created by the implementation

- Duplicate pre-transaction authorization.
- Runtime/override dependency bags with implicit precedence.
- Repeated nested shallow freezing and copying.
- Approximately 160 exact-optional-property spread expressions.
- Multiple route, cursor, response, and persisted-row parsing styles.
- Large nested factories whose measured top-level branch counts hide many
  responsibilities.
- Repeated shutdown and abort-listener mechanics.
- Long `instanceof` error mapping ladders.
- Historical phase names in current implementation terminology.
- Repeated graph collection scans that one validation index could replace.

## 11. Necessary complexity

The following implementations are complicated because the product and failure
model are complicated. They should remain explicit:

- coordinator state transitions and observation generation;
- checkpoint boundary parsing and executable verification;
- node-attempt lease, fence, dispatch, and completion logic;
- outbox publication and unknown-outcome reconciliation;
- webhook signature and secret-rotation verification;
- secure HTTP DNS, redirect, address-policy, bounding, and redaction flow;
- workspace purge and legal-hold sequencing;
- retention claim, page, and settlement processing;
- control-ledger recovery and replica reconciliation; and
- compatibility-release locking and publication atomicity.

Generic workflow frameworks, repository base classes, universal command buses,
or declarative lifecycle DSLs would make these areas harder to debug rather
than cleaner.

## 12. TypeScript cleanup opportunities

Ranked by value:

1. Replace contradictory runtime/override dependency bags with discriminated
   variants.
2. Export named types such as `WorkspaceAuthorizationSource` instead of using
   `Parameters<typeof authorizeWorkspace>[0]['access']` at multiple sites.
3. Standardize persisted rows on strict, file-owned schemas.
4. Replace simple tag-only error subclasses with feature-owned coded errors and
   exhaustive mapping.
5. Normalize optionality at interfaces where explicit `undefined` has no
   semantic difference, reducing spread ceremony.
6. Make transitions from unknown to trusted values visible through named
   command, row, and domain types.
7. Retain the current discriminated unions, `satisfies`, `as const`, and
   exhaustive `assertNever` patterns.
8. Retain the prohibition of broad assertions, `any`, unsafe double casts, and
   non-null assertions in production code.

## 13. Runtime immutability assessment

The repository contains approximately 1,000 `Object.freeze` calls. Runtime
freezing is justified for:

- exported constants and policy catalogs;
- node and compatibility registries;
- configuration objects shared across runtime owners;
- cloned durable values whose mutation would invalidate checksums or identity;
  and
- request/authorization contexts intended to be immutable capabilities.

It is less valuable for ephemeral row mappings and owner-local response DTOs,
especially when nested values are not recursively frozen. Establish an explicit
policy and remove ceremonial freezes incrementally after tests prove that no
caller relies on mutation throwing. Do not perform a repository-wide mechanical
removal.

## 14. Realistic code-level performance cleanup

- Build graph validation indexes once instead of repeatedly scanning up to
  1,000 nodes and 4,000 edges.
- Eliminate the repeated workspace-access query on guarded requests.
- Avoid reparsing and recopying large workflow graphs while creating ETags and
  response shapes.
- Avoid repeated nested freezing after a trusted immutable seam.
- Add bounded failure deadlines to Redis rate-limit operations.
- Represent queue/outbox timeout outcomes truthfully rather than allowing
  invisible background publication.
- Project compatibility manifests once and derive supported/placeable views.

Small bounded result arrays, error-code lists, startup configuration parsing,
and similar low-volume operations should not be micro-optimized.

## 15. Canonical implementation patterns

| Concern | Best current pattern | Code that should converge |
| --- | --- | --- |
| Tenant transactions | `packages/database/src/workspace.ts#runTransaction` | Failure notifications and future tenant stores |
| Error handling | Coded errors such as `SecureHttpError` plus exhaustive layer-owned mapping | Tag-only class families and repetitive mapper ladders |
| Cleanup | `closeWorkflowResources` collecting all failures in `AggregateError` | Shutdown implementations that throw only the first failure |
| Dependency composition | Small explicit runtime holders such as `createApiWebhookRuntime` | API application and worker transport dependency bags |
| Telemetry | Feature-owned adapter with no-op/default implementation | Continue; do not create one universal telemetry abstraction |
| Runtime parsing | Strict input and row schemas in `workflow-run-api.ts` | Workflow authoring and older database row mappers |
| Tests | Focused interface-level unit tests plus real-adapter integration suites | Continue; add timer/abort races for lifecycle primitives |

## 16. File and function hotspots

| File and symbol | Approximate size | Responsibility count | Recommended action |
| --- | ---: | ---: | --- |
| `workflow-engine/coordinator-observations.ts#forEachCoordinatorObservations` | 220 lines / 44 branches | 1–2 | Leave mostly intact; extract only independently named observation families |
| `database/phase3-checkpoint.ts` schema refinement | 142 / 44 | 1 | Keep explicit; rename historical source terminology |
| `database/node-attempt-run-store-inputs.ts` transaction callback | 264 / 43 | 3 | Extract row parsing and input reconstruction while preserving transaction order |
| `workflow-engine/operations.ts#assertCheckpointMatchesExecutable` | 178 / 42 | 1 | Leave intact |
| `workflow-engine/checkpoint.ts#parseJoin` | 201 / 41 | 1 | Leave intact |
| `workflow-engine/checkpoint.ts#parseCheckpointV1Boundary` | 270 / 39 | 1 | Leave intact |
| `worker/node-attempt-runtime.ts#createNodeAttemptRuntime` | 177 / 37 | 5 | Split resource construction, capability assembly, and consumer ownership |
| `workflow-engine/executable-workflow.ts#assertSafeExecutableJson` | 126 / 37 | 1 | Leave intact |
| `database/workspace-purge.ts#processNext` | approximately 533 / 19 | 5 | Extract named stages while retaining linear sequencing |
| `database/workflow-authoring.ts#createWorkflowAuthoringDatabase` | approximately 498 / 21 | 8–10 | Split implementation modules behind the same facade |
| `database/identity-workspace.ts#createIdentityWorkspaceDatabase` | approximately 505 / low top-level branching | 10+ | Split identity, session, workspace, and lifecycle implementation |
| `worker/transport.module.ts` | 607-line file | 7+ | Divide private provider construction by owned runtime |

## 17. Senior-engineer readability test

| Subsystem | Rating | Reason |
| --- | --- | --- |
| Workflow authoring | Good | Use cases and contracts are clear; repeated parsing/auth and large persistence file add ceremony |
| Execution engine | Difficult but justified | Dense parsing and state logic reflects real invariants |
| Coordinator | Difficult but justified | Durable transition behavior requires multiple coordinated representations |
| Node attempts | Difficult because of implementation structure | Runtime construction and handler ownership are spread across large dependency shapes |
| Integrations | Good | Definition, executor, secure transport, and provider roles are understandable |
| Triggers | Good | Core flow is coherent; lifecycle helper style has drifted |
| Identity/workspaces | Difficult because of implementation structure | One database implementation owns too many capability families |
| Lifecycle/deletion | Difficult but justified | Ordering, fences, legal holds, and external cleanup are inherently complex |
| Retention | Difficult but justified | Correct paged maintenance is explicit but source files are large |
| Recovery | Excellent | Linear readiness/reconciliation/inventory flow is easy to follow |
| Database layer | Difficult because of implementation structure | Strong transaction machinery but flat layout and inconsistent row parsing reduce locality |
| API composition | Good | Feature modules are clear; runtime override combinations are less clear |
| Worker composition | Difficult because of implementation structure | Transport module aggregates too many runtime owners |

## 18. Refactoring traps

Do not:

- replace transactional state transitions with a generic repository framework;
- hide lock or fence ordering behind generic step abstractions;
- merge preview and durable node attempts merely because their outlines look
  similar;
- remove persisted checkpoint, executable, checksum, or compatibility checks as
  duplicate validation;
- parallelize deletion, retention, or recovery operations whose order is part
  of correctness;
- treat possibly dispatched external calls as ordinary retryable failures;
- centralize every error into a global error package;
- create generic helpers for every exact-optional-property spread;
- split parser functions solely to satisfy a line-count target; or
- replace webhook and secure HTTP linear security flows with declarative
  middleware chains.

## 19. Refactor priority

### 19.1 High value and low risk

**Group verification (2026-09-03):** `pnpm check` passed after the completed
remediations and C-05 prerequisite: formatting, documentation, runtime-major
policy, all builds, lint, complexity ratchet, generated contracts, all
typechecks, and 1,537 package/application unit tests. The ratchet was not relaxed.

- Correct the worker runtime dependency classification.
- Own or unreference the worker keepalive timer.
- Remove the no-op workflow catch/rethrow.
- Fix trigger abort-listener cleanup.
- Export named authorization-source types.
- Standardize route and cursor parsing.
- Deduplicate compatibility catalog projection.

### 19.2 High value and medium risk

**Group verification (2026-09-03):** `pnpm check` passed after C-02, C-05,
C-10, C-12, C-13, C-14, and C-18: formatting, documentation, runtime-major
policy, all builds, lint, complexity ratchet, generated contracts, all
typechecks, and 1,556 package/application unit tests. PostgreSQL integration
checks that require the unavailable local database are recorded under their
individual findings rather than represented as passing.

- Move failure notifications onto the canonical tenant transaction primitive.
- Eliminate duplicate guard/use-case authorization safely.
- Split worker transport composition.
- Replace weak database row coercion with strict schemas.
- Introduce feature-aware exception-filter composition.
- Adopt one cleanup aggregation policy per application.
- Split large database implementations while preserving facades.
- Index executable graph validation.

### 19.3 Valuable but risky

- Redesign queue/outbox timeout and unknown-outcome behavior.
- Add a bounded Redis rate-limit degradation policy.
- Reduce error-class proliferation.
- Redesign broad runtime dependency composition with discriminated sources.
- Reduce graph/checkpoint freezing and reparsing after profiling and mutation
  characterization.

### 19.4 Leave alone

- Checkpoint parsers.
- Core transition functions.
- Coordinator observation semantics.
- Lease and fence state machines.
- Secure HTTP linear validation.
- Webhook verification sequencing.
- Workspace purge sequencing.
- Retention and recovery correctness flows.
- Current package boundaries.
- The absence of generic shared utility packages.

## 20. Final conclusion

The project was not built from a deficient or contradictory plan. The plan is
unusually explicit about TypeScript quality, seam parsing, error mapping,
transaction ownership, module organization, testing, and avoiding speculative
abstractions. The implementation follows most of that direction.

The remaining craft debt comes from three sources:

1. a few direct deviations from plan rules, especially parse-once, exception
   mapping, authorization ownership, graceful shutdown, transaction reuse, and
   dependency declaration;
2. source-layout convergence that the plan explicitly anticipated but the
   implementation has not completed; and
3. implementation details the plan did not prescribe, such as timer helpers,
   row-schema conventions, freeze policy, cleanup aggregation, and graph
   indexing.

The correct next step is not to redesign the system. It is a sequence of
characterized, behavior-preserving refactors around the current deep module
interfaces, followed by the few behavioral corrections whose semantics are
already required by the plan.
