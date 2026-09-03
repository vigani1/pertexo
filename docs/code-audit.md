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
- **Remediation status:** in progress; the low-risk type-ownership prerequisite
  is complete, while removing duplicate guard/use-case lookups remains in the
  medium-risk group.
- **Repository-wide type locations:** seven workflow-authoring constructors and
  its authorization helper, four workflow-run constructors and its helper, and
  four connection constructors and its helper derived the access-source type
  through `Parameters<typeof authorizeWorkspace>`. No such derived type remains.
- **Prerequisite remediation:** `WorkspaceAuthorizationSource` is now owned and
  exported by the workspace authorization module. Identity/workspace ports
  re-export that canonical type for compatibility instead of redefining its
  union. This is type-only and does not change any authorization lookup.
- **Prerequisite verification:** repository-wide search for the derived
  `Parameters` form; API typecheck and the workflow-authoring, workflow-run,
  connection, authorization, and guard suites recorded with the medium-risk
  behavior change.
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

- Correct the worker runtime dependency classification.
- Own or unreference the worker keepalive timer.
- Remove the no-op workflow catch/rethrow.
- Fix trigger abort-listener cleanup.
- Export named authorization-source types.
- Standardize route and cursor parsing.
- Deduplicate compatibility catalog projection.

### 19.2 High value and medium risk

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
