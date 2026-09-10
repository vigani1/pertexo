# Backend readability and simplification plan

Status: **planned; no implementation performed by this review**.

## Purpose and authority

Make the existing repository easier to read, reason about, and safely change.
This is not another numerical quality-score exercise. Passing tests, complexity
limits, or a previous Q9 review does not establish that the code is readable.

The immediate concerns are oversized compound conditions, executable logic inside
conditions, functions dominated by failure bookkeeping, mixed responsibilities,
duplicated policy, obscure names, and unexplained literals. Address the whole
repository, including tests and infrastructure, without introducing a framework
for every repeated pattern.

For this work, follow `AGENTS.md`, `CONTEXT.md`, relevant ADRs, current public
contracts, and the existing implementation. The backend checkpoint blueprint
remains authoritative for checkpoint work. This plan does not reopen settled
architecture, change lifecycle terminology, or supersede compatibility policy.
Do not rewrite historical plans/progress as if readability work were already done.

## Snapshot, coverage, and limitations

Snapshot taken on 2026-09-10 at 18:55 UTC:

- HEAD: `0710322c3b541000d4c260c1143081278b95315b`, branch `main`.
- The working tree, not HEAD alone, was reviewed. It already contained 69 modified
  tracked files and 12 untracked files, including recent Q9 implementation.
- Git reported the local branch four commits ahead of its recorded upstream.
  This review did not fetch, commit, push, start services, or alter implementation.
- Discovery covered 1,529 tracked/non-ignored files, including 1,220
  TypeScript/JavaScript files. Ignored generated output, dependencies, coverage,
  runtime evidence, and local secrets were excluded.
- Automated candidates: 131 conditions (129 non-test, 2 test) and 364 functions
  (108 non-test, 256 test). These are overlapping review signals, **not 495
  defects**. Large test-suite callbacks and declarative registration functions
  account for many function flags.

[The inventory](backend-readability-inventory.json) records every flagged
condition/function, its original locator, metrics, and initial review status.
Its source fingerprint identifies the scanned code contents, including dirty
work. Line numbers below are snapshot anchors; resolve by symbol after edits.

Read-only reviewers divided applications, database, and other packages; the
primary reviewer inspected infrastructure and cross-cutting policy and checked
representative reported findings. This was repository-wide discovery plus
targeted semantic review, **not line-by-line certification of every file**.
SQL, shell, YAML, JSON, documentation, generated artifacts, and embedded scripts
need the explicit manual coverage pass in R15; AST flags do not certify them.

| Area | Discovery coverage | Planned disposition |
| --- | --- | --- |
| API | 245 code files, including 90 test/support files | R04, R05, R07, R13, R14 |
| Worker | 139 code files, including 78 test/support files | R05, R06, R10, R14 |
| Lifecycle / operator / recovery / retention apps | 34 code files, including 14 test/support files | R05, R10, R13 |
| Database | 359 code files, including 176 test/support files; migration SQL also inventoried | R02, R08, R09, R13, R14 |
| Workflow engine / model | 112 code files, including 38 test/support files | R03, R13, R14 |
| Integrations | 44 code files, including 10 test/support files | R11, R13 |
| Node SDK / catalog / core nodes | 93 code files, including 15 test/support files | R12, R13, R15 |
| Artifact store / queue / rate limit / observability | 91 code files, including 39 test/support files | R05, R11, R13, R15 |
| Infrastructure | 64 code files, including 27 tests, plus operational assets | R01, R05, R13, R14, R15 |
| Contracts | 38 code files, including 9 test/support files, plus generated artifacts | R13, R15; preserve generator ownership |
| Root / CI / docs / build configuration | Inventoried separately; one root JS config in AST scan | R15; do not infer cleanliness from zero AST flags |

## What a successful refactor looks like

A reader should be able to explain a function's purpose, business rules, failure
precedence, and resource lifetime without mentally executing a giant condition
or chasing trivial wrappers through many files.

Use these rules throughout:

1. **Name the rule, not the syntax.** Prefer
   `assertCheckpointJoinIdentity` over `validatePart1`. A local boolean is
   enough when it removes mental work; a one-use helper is not automatically better.
2. **Separate distinct rules, not every comparison.** A short homogeneous status
   check can remain an OR chain. A condition mixing shape, identity, timing,
   privilege, and nested try/catch needs ordered, named phases.
3. **Preserve short-circuiting and first failure.** Do not eagerly compute
   predicates that dereference unvalidated data, query a database, call a clock,
   invoke getters, mutate state, or throw. Preserve observable error codes,
   messages where contractual, and validation order. Never use a catch-all
   predicate to silently convert an unexpected failure into ordinary invalid input.
4. **Keep ownership visible.** The function acquiring a client, timer, listener,
   heartbeat, stream, temporary directory, or credential must make its release
   obligation obvious. Cleanup must not disappear into an opaque callback bag.
5. **Treat rejection as state, not truthiness.** JavaScript can throw/reject
   `undefined`. Preserve explicit failed tags/presence checks. A tagged outcome
   is useful only where it simplifies actual bookkeeping; no repository-wide
   Result framework or blanket conversion of exceptions.
6. **Extract a real policy once.** Prefer private helpers and existing package
   owners. Do not create global `utils`, `constants`, universal validators,
   generic workflow runners, or a new exported seam just to shorten a file.
7. **Keep algorithms and transactions cohesive.** No extra queries, clients,
   traversals, serializations, copies, or materialized arrays merely to make
   functions smaller. Preserve bounds and one-pass/shared-projection work.
8. **Do not improve metrics by concealment.** Moving a condition unchanged into
   `isValidEverything`, splitting files mechanically, adding exemptions, or
   replacing explicit checks with opaque data-driven dispatch is not completion.
9. **Tests are readable specifications.** Show the scenario, distinctive input,
   action, and expected behavior. Reuse setup mechanics, not production-derived
   expected answers. Add missing characterization, not redundant count-padding.
10. **Comments explain why.** Remove stale/redundant narration in touched code;
    retain rationale for unusual failure ordering, compatibility, and security.

For example, integration-evidence validation currently combines structural
checks, identity comparisons, and an immediately invoked function that catches
interval validation errors in one condition. The desired shape is an ordered
sequence of structural admission, identity/source binding, and interval checks
behind the same public error contract. Merely relocating the entire OR chain
to `isValidEvidence` would not achieve that.

## Execution protocol

### R00 — Establish the implementation ledger

Before changing code:

- Read the current dirty diff and relevant prior Q9 changes. Record which work
  predates this task. Do not reset, overwrite, commit, or push that work.
- Reconcile the inventory against the current checkout. Mark moved/deleted
  symbols with their replacement locator instead of silently dropping rows.
- Create a readability implementation ledger. For each R item, record owner,
  exact files/callers, status, chosen shape, protected behavior, verification,
  and any justified retention. Keep the baseline inventory immutable; record
  candidate dispositions in the ledger or a separate keyed result file.
- Use candidate keys such as `C001` and `F001`. Every candidate eventually
  needs one of: changed, retained with concrete reason, or blocked with a named
  missing decision. Group disposition is allowed only with every member listed
  and the reason genuinely applicable to all members.
- For each proposed family, search **all** occurrences and consumers, including
  ones below the scan thresholds. Record that finite rollout set before editing.
- Start from existing public tests. Add characterization where failure order,
  race outcomes, query order, or policy combinations are not covered.
- No ADR is needed for ordinary private refactoring. Stop for direction if the
  proposed fix changes an architectural/public contract.

### R01 — Infrastructure validation phases (first implementation slice)

**Strong targets**

- `infrastructure/report-risk-coverage.mjs`:
  `assertProducedResultInterval` (~118), `produceIntegrationEvidenceArtifact`
  (~151), `validatedIntegrationEvidence` (~199; nested condition ~226).
- `infrastructure/performance/compare-local-benchmark.mjs`:
  `requireSummary` (~19), `requireScenarioDatabaseEvidence` (~157),
  `assertEvidence` (~535).
- `infrastructure/performance/run-local-benchmark.mjs`:
  `parseOperationSamples` (~153), `validateManifest` (~202),
  `validateOperationContract` (~404).
- `infrastructure/exercises/run-http-exercise.mjs`:
  response-policy validation (~42) and profile/header validation (~115).
- `infrastructure/ecs/validate-deployment.mjs`: workload checks (~273–323).

**Change**

Split heterogeneous checks into private, ordered rule groups. Benchmark groups
should distinguish version/shape, scenario population, timing/derived values,
process observations, database policy, participant identity, and overlap.
Separate header collection shape from per-header restrictions and semantic
response-code policy. Keep existing parsers/assertion owners; do not add a schema
library for this refactor or unify producer normalization with comparator policy.

**Preserve**

All supported/rejected versions; identity/source/run binding; producer interval
and named-test evidence; duration/throughput math; scenario populations; database
role/application identity; overlap proof; error classification; required evidence.
Do not make expected benchmark statistics call the producer's calculation.
Keep integration-evidence, benchmark-evidence, and timing-marker versions distinct.
Preserve fail-closed header/auth restrictions and exercise bounds.

**Verify**

Run the matching `node --test` files for report-risk-coverage,
performance/run-local-benchmark, performance/compare-local-benchmark,
exercises/run-http-exercise, and ECS validators. Add combined-invalid-field cases
to prove validation order and malformed-shape cases to prove safe short-circuiting.
Run `pnpm performance:local:check`, `pnpm exercise:check`, or
`pnpm deployment:check` for the respective changed family.

**Done when**

The top-level path names the distinct rules, no IIFE/try-catch remains buried in
these mixed conditions, and no check or independent evidence oracle was removed.
Other infrastructure flags are explicitly disposed in R15.

### R02 — Database readiness and privilege predicates

**Targets**

- `packages/database/src/operator/operator-command-runtime.ts`:
  `checkReadiness` (~158).
- `packages/database/src/platform/readiness-probe.ts` (~148) and
  `platform/readiness.ts` (~42).
- All related database condition candidates, especially capability snapshots
  and protected-table grants; inspect siblings before choosing shared predicates.

**Change**

Separate snapshot acquisition from named assertions for expected role,
forbidden memberships/direct grants, supported schema/release, and required
capabilities. Use a typed snapshot and small private checks. Do not replace an
explicit privilege inventory with a permissive generic key loop. Similar-looking
readiness variants may have deliberately different allowed operations.

**Preserve**

One snapshot/transaction and the same SQL, role inventory, RLS checks, query
ordering, cancellation, and fail-closed behavior. Diagnostic changes are not
automatically authorized. Do not weaken checks to improve readability.

**Verify**

`readiness-probe.test.ts`, `serving-readiness.test.ts`,
`rls.integration.test.ts`, `transport.integration.test.ts`, and relevant
artifact/workflow-authoring readiness tests under `packages/database/test`.
Add explicit negative operator-readiness cases: wrong role, forbidden membership,
direct grant, missing capability, and unsupported state; current direct negative
coverage is not sufficient to assume a refactor is safe.

### R03 — Workflow identity and bounded validation

**Targets**

- `packages/workflow-engine/src/operations.ts`:
  `assertCheckpointMatchesExecutable` (~134).
- Remaining flagged conditions in engine checkpoint/executable validation and
  workflow-model graph/schema validation.
- Review, but do not redo, recent shared graph traversal and persisted-checkpoint
  refinements in workflow-model/database.

**Change**

Evaluate private join-identity, invocation-scope, admission, and loop-invariant
checks, invoked in original order under the existing authority. Retain a unified
function if extraction merely hides the coupled proof; document that decision
against the actual candidate. Keep V1/V2 and persisted/executable contracts distinct.

**Preserve**

Workflow/version/node/invocation identity, branch and iteration paths, legacy
empty-scope allowances, error precedence, traversal/fact/byte bounds, and existing
cached/shared traversals. Do not reparse or rescan the graph per extracted check.

**Verify**

Engine `operation-risk-branches.test.ts`, `checkpoint-risk-branches.test.ts`,
`checkpoint-seam.test.ts`, `executable-workflow-foreach.test.ts`,
`nested-parallel-admission.test.ts`, and `q9-bounded-work.test.ts`;
model `workflow-graph-contract.test.ts`; relevant database compatibility and
worker identity consumers. Include two-invalid-invariants cases for first failure.

### R04 — API input rules and configuration refinements

**Targets**

- `apps/api/src/identity-infrastructure/oidc-adapter.ts`:
  `authorizationUrl` (~144 condition) and `exchangeCode` (~185 condition).
- `apps/api/src/app.ts`: `assertValidRuntimeSources` (~314; condition ~376).
- Configuration/refinement candidates across all six apps and database config.

**Change**

For OIDC, name token syntax/bounds, registered redirect/client binding, and scope
policy separately. Keep authorisation and token-exchange error contracts distinct.
For config, extract only genuinely identical pure policy (for example production
telemetry requirements); leave role-specific defaults and discriminated command
schemas local. Retain simple runtime/override exclusivity checks if already clear.

**Preserve / verify**

No relaxation of PKCE/state/nonce, URL, scope, or redirect restrictions; no changed
environment names, defaults, validation issue paths, or production gates.
Use `apps/api/test/identity-infrastructure/oidc-adapter.test.ts` and app-specific config/bootstrap tests;
verify the file locator before running as layouts evolve. Exercise exact bounds
and multi-invalid inputs. Config extraction is conditional, not a global rewrite.

### R05 — Cleanup bookkeeping and resource ownership

**Targets**

- All four command/recovery entry points:
  `apps/lifecycle-command/src/run.ts` (~23),
  `apps/operator-command/src/run.ts` (~42),
  `apps/recovery/src/restore-before-serve.ts` (~88),
  `apps/retention/src/run.ts` (~38).
- `apps/api/src/app.ts`: startup/partial-startup shutdown (~107).
- Queue `consumer.ts` `process` (~433), `performClose` (~558);
  producer and rate-limit Redis teardown for comparison, not forced unification.
- Artifact-store dual-region store/ledger `close` (~166/~300).
- Infrastructure `run-local-quality.mjs` `run` (~814), benchmark
  `executeRound` (~694)/`benchmark` (~1043), and
  `postgres-evidence.mjs` `runPoolContentionSamples` (~99).
- All six apps' `src/main.ts` partial-bootstrap fallback cleanup, for comparison
  and explicit retention of original-error-preserving best-effort behavior.

**Change**

First write an ownership/error table for each target: resources acquired,
partial-initialization state, normal release order, abort behavior, timeout,
primary failure, cleanup failure, and both-fail result. Then remove duplicated
bookkeeping locally where useful. A small ordered cleanup collector may be
appropriate within an existing owner; a cross-app process framework or runtime
registry class is **not** the default. API startup can use private staged functions.

Keep synchronous close synchronous. Do not replace ordered close with
`Promise.all`. Preserve sequential versus best-effort/all-attempted behavior.
Use a local tagged outcome only when needed to distinguish success/undefined
from rejection/undefined. Benchmark pool sampling can isolate one checkout round
without hiding pending waiters or moving pool ownership.

**Retain unless a concrete improvement is demonstrated**

Worker `completeWithCleanup`, benchmark evidence write/cleanup, telemetry
isolation catches, `OwnedProcessSupervisor`, and database transaction cleanup
already have meaningful ownership. Counting catches is not a reason to rewrite them.

**Verify**

Each command's `run.test.ts`, recovery `restore-before-serve.test.ts`,
API `api-bootstrap.test.ts`, queue consumer/producer tests, rate-limit
`redis-runtime.test.ts`, dual-region artifact/ledger tests, and infrastructure
runner tests. Cover success, operation-only failure, cleanup-only failure, both,
undefined rejection, partial construction, timeout, repeated close, and abort.
Assert retained error identity/order and that every owned resource is attempted
exactly as the existing contract requires.

Bootstrap coverage is uneven: direct worker `worker-bootstrap.test.ts` and
lifecycle-command `main.test.ts` exist, but do not assume equivalent dedicated
coverage for the other four `main.ts` fallback paths. Add characterization at
their bootstrap seam before changing those paths; merely retaining them does
not require a new universal process harness.

### R06 — Worker attempt and artifact phases

**Targets**

- `apps/worker/src/execution/node-attempt-handler.ts` (~221–459).
- `apps/worker/src/execution/preview-attempt-handler.ts` (~399–516).
- `apps/worker/src/execution/node-runtime-capabilities.ts`:
  artifact body/upload work (~123–284), assembly/shutdown (~339–475).

**Change**

Start with handler-local heartbeat start/stop and outcome-mapping phases. Compare
production and preview semantics explicitly before sharing supervision.
A common `runLeasedAttempt` is only justified if its interface is smaller than
the duplicated mechanics and does not require mode flags or many phase callbacks.
Keep production durable control and preview deadline-race policy visible.

For artifacts, separate bounded spooling from pending-record/upload/finalization
where this exposes a real phase. Keep ownership and the existing cleanup primitive
visible; do not add extra copies or allow a helper to leak a temporary resource.

**Preserve**

Heartbeat join/stop, cancellation and deadline precedence, undefined rejections,
lease-loss and unknown-dispatch semantics, immutable claimed identity,
provider fence/evidence, chunk zeroization, byte bounds, abort checks,
pending-before-upload order, metadata equality, expiry and resource ownership.

**Verify**

Worker `node-attempt-handler.test.ts`, `node-attempt-handler-part-2.test.ts`,
`preview-attempt-handler.test.ts`, `node-runtime-capabilities.test.ts`,
`artifact-reference.integration.test.ts`, runtime/consumer tests, and relevant
resilience suites. Characterize completion/deadline/heartbeat/abort races before
sharing supervision. Test failure combinations without timing-dependent sleeps
where existing deterministic seams are available.

### R07 — API connection testing and webhook phases

**Targets**

- `apps/api/src/connections/connection-testing.ts`: `execute` (~60).
- `apps/api/src/webhooks/ingress.ts`: `acceptWebhook` (~96).

**Change**

Connection testing: separate provider transport tests from common claim,
reauthorization, secret lifetime, dispatch marking, and completion. Prefer private
typed functions and a common normalized result over a strategy registry/class.
Keep email, Slack, and HTTP result policy visibly provider-specific.

Webhook ingress: introduce named phases for request admission, authenticated
secret verification, delivery parsing, durable acceptance, and response mapping.
Do not make an extra generic request pipeline. Retain the outer visible ordering.

**Preserve**

Exactly-once completion/abandon decisions, replay handling, authorization,
credential zeroization, provider error disclosure and dispatch evidence.
Webhook rate-limit consumption remains before timestamp freshness evaluation;
current/previous secret behavior and authentication-before-JSON-parsing remain.
Keep HTTP status/problem codes, idempotency and unavailable/conflict behavior.

**Verify**

API connections `use-cases.test.ts`, `http-stack.test.ts`,
`controllers.test.ts`, `credential-boundaries.test.ts`, `telemetry.test.ts`;
webhooks `ingress.test.ts` and `direct-webhook.integration.test.ts`.
Add ordering and provider-outcome cases at the existing interfaces, not tests
coupled to every new private helper.

### R08 — Database observation and completion policy

**Targets**

- `packages/database/src/execution/coordinator-run-store-observations.ts`:
  `loadCoordinatorAdvanceState` (~452).
- `packages/database/src/execution/failure-notification-completion-store.ts`:
  `completeDelivery` (~19).

**Change**

Observation loading: private typed phases for persisted run/checkpoint reads,
fact admission/projection, physical execution observations, and artifact/wakeup
checks. Keep one repeatable-read client and top-level query order visible.
Do not split one consistency proof across independent transactions.

Notification completion: isolate the retry/terminal decision from SQL mutation
using a small discriminated decision if it makes the policy clearer. Keep stale
and incompatible predispatch checks first, and persistence/outbox/audit atomic.

**Preserve**

Existing 1,000-row read-page and 10,000-fact bounds, fail-fast/query count,
checkpoint identity, cancellation/deadline proof, outbox order, retry exhaustion,
unsafe/idempotent semantics, and accumulated possibly-dispatched ambiguity.

**Verify**

Database `coordinator-run-store-observations.integration.test.ts`,
`coordinator-run-store-commit-output.integration.test.ts`,
`coordinator-run-store-wakeups.integration.test.ts`,
`coordinator-run-store-cas.integration.test.ts`, and scheduling integration tests.
Add a completion-policy matrix covering claimed/dispatching, delivered/retry/
unknown, side-effect class, attempt exhaustion, and prior/current dispatch
evidence. Existing scheduling tests exercise only a small portion of that matrix.
Query-order/count characterization must precede observation extraction.

### R09 — Migration runner and database configuration locality

**Targets**

- `packages/database/src/migrations.ts`: `migrateDatabase` (~251),
  `runNonTransactionalMigration` (~122).
- `packages/database/src/config.ts` (~58) for repeated role/config assembly.

**Change**

Separate migration discovery/execution-plan work from private session-owned
execution phases only where this clarifies the runner. Preserve one obvious
advisory-lock/client owner. Do not introduce a universal transaction/session
framework. Compare role-specific schema assembly before extracting identical
fields; migration and operator restrictions must remain explicit.

**Preserve / verify**

Pool `max: 1`, advisory lock, role/reset/unlock order, checksum compatibility,
resumable bounds, progress-observer isolation, rollback and combined failures.
Never rewrite append-only SQL migrations for style or consolidate historical
SQL literals. Run `migration-runner.test.ts`,
`migration-execution-plan.test.ts`, `migration-checksum-compatibility.test.ts`,
`migration-execution-modes.integration.test.ts`,
`published-migration-repair.test.ts` and its integration suite, plus config tests.

### R10 — Retention loops and outbox flow

**Targets**

- `apps/retention/src/maintenance-loops.ts` (~103–397).
- `apps/worker/src/transport/outbox-dispatcher.ts`:
  `dispatchOnce` (~231), `dispatch` (~316).

**Change**

Retention loops repeat timing/recovery/backoff machinery. Extract that narrow
mechanism only if each operation still reads clearly. Keep typed operation
functions responsible for metrics, progress meaning, and immediate-continue
versus polling decisions. Reject a descriptor with so many callbacks that it
becomes harder to understand than the loops. Enumerate all eight operation loops.

Outbox: separate batch claim/aggregation from publish/settle and failed-publication
release. Prefer small local functions over a new state-machine framework.

**Preserve / verify**

Readiness gates, per-operation failure state/backoff, signal reasons, polling
semantics, published/unknown/stale/failed outcomes, settlement order, capacity
scheduling, best-effort observation, draining, and bounded close.
Run retention `run.test.ts`, worker `outbox-dispatcher.test.ts`, and relevant
transport/resilience integration tests. Add table-driven retention cases for each
operation's idle/progress/capacity-limited behavior and cancellation during delay.

### R11 — Integration and package-local transport lifetimes

**Targets**

- `packages/integrations/src/slack/executor.ts` (~120),
  `email/executor.ts` (~121).
- `packages/integrations/src/http/secure-http.ts`:
  `executeOwnedRequest` (~222).
- Remaining artifact/queue/rate-limit candidates not disposed in R05.

**Change**

Consider a small credential-lifetime phase for Slack/email; keep unsafe Slack
versus idempotent email outcome policy separate. The existing
`createProviderBeforeDispatch` already owns the fence; use it.
Secure HTTP may extract redirect transition validation and final-body consumption;
keep dispatch-marker state, deadline, and response closure in the orchestration.

**Preserve / verify**

SSRF/DNS/redirect admission, original timeout budget, possibly-dispatched/error
stage semantics, credentials and chunk zeroization, body limits and stream closure.
Keep `http/outcome-policy.ts` authoritative. Retain the recent HTTP body-error
cleanup work unless a demonstrable readability improvement preserves it.
Run integrations `slack-send-message.test.ts`,
`email-send-notification.test.ts`, `secure-http.test.ts`,
`http-request.test.ts`, and `http-outcome-policy.test.ts`.
Do not merge queue/Redis lifecycle helpers across packages merely because their
timer/disconnect code resembles one another.

### R12 — Registry successor validation

**Target**

`packages/node-sdk/src/release.ts`:
`createRegistryReleaseSuccessor` (~463–550).

**Change**

Use definition-successor and executor-successor private validation phases.
Share identity-map construction only if types and call sites remain simpler.
Do not replace two typed models with a generic manifest bag.

**Preserve / verify**

Authoritative lifecycle transition tables, immutable projections, retirement
before removal, new-entry rules, epoch continuity, fingerprints and first failure.
Run SDK `registry.test.ts`, catalog `release-history.test.ts`, golden/history,
retained registry, browser/server registry and compatibility consumers.
Keep golden expected history independent of runtime derivation.

### R13 — Constants, naming, and duplicated policy

Apply alongside each owning slice, then perform a full repository occurrence
search. **Same spelling/value is not proof of the same policy.**

| Candidate | Decision and owner |
| --- | --- |
| Three `timeoutMillis: 15_000` values in API connection tests | Strong local candidate: `CONNECTION_TEST_TIMEOUT_MILLIS` in connection testing, if all provider tests intentionally share this policy. Keep all three consumers aligned. |
| Webhook freshness allowance of 300 seconds in ingress | Name the local authentication policy with units; preserve value and database-clock comparison. Do not reuse unrelated five-minute values. |
| Benchmark evidence schema version 4 in producer/comparator | Consider one private infrastructure contract constant for runtime consumers. Keep manifest format, evidence format, and compatibility history explicit even if versions currently match. |
| `PERTEXO_Q11_OPERATION_V2=` and timing schema version 2 | Already named in the parser. Inventory emitters and support files; share runtime protocol ownership only without a forbidden package import. Independent invalid/legacy fixtures must still contain explicit wire values. |
| Integration evidence version 3 versus benchmark version 4 | Different contracts: never one global `SCHEMA_VERSION`. |
| Pool-contention rounds / wait durations / threshold | Local unit-bearing policy names where they explain the measurement. Keep measurement and asserted threshold distinct. |
| Exercise entry, header, and problem limits | Name meaningful local bounds, following existing duration/rate/in-flight constants. Do not turn every HTTP status into a new constant. |
| Existing typed statuses, discriminants, error codes, env keys, SQL roles | Reuse existing authoritative exports when appropriate; keep readable typed literals when no policy is duplicated. No enum conversion campaign. |
| Sanitization, canonical JSON, artifact, queue, loop bounds | Keep domain-specific owners; equal numbers can protect different contracts. |
| CI image/runtime pins and migration wire values | Preserve reproducible configuration/history; use existing validators to detect drift, not a new TS import layer into YAML/SQL. |

For every new constant record the meaning, units, owner, complete runtime consumer
set, and which tests deliberately retain literal expectations. Prefer
`retryDelayMillis`/`maximumPersistedFacts`-style names over vague `limit`,
`data`, `result2`, or `isValid` when meaning is otherwise unclear.
Do not lift single-use log messages, standard `typeof` strings, or obvious
discriminants into a constants file.

### R14 — Test readability and fixture ownership

**Targets**

Every test candidate in the inventory, plus repeated setup/teardown and embedded
subprocess programs missed by AST analysis. Important examples:

- Database: repeated `new Pool(...)`/create/drop lifetime across test/support
  files; inspect existing `support/disposable-database.ts` before adding helpers.
  The scan/review found 252 pool-construction sites across 70 files; these are
  discovery leads, not 252 mandatory replacements.
- `infrastructure/performance/run-local-benchmark.test.mjs`: long embedded
  subprocess strings (~75, ~827) obscure the workload/barrier behavior.
- Large API/worker/engine/database describe callbacks: classify the nested
  individual tests; a large grouping callback alone is not an unreadable function.

**Change / preserve**

Extract identical fixture mechanics into existing support owners. Keep scenario
inputs and expected errors/outcomes in the test. A readable fixture script may
replace an embedded program, but preserve separate-process behavior, explicit
invalid fixtures, barriers, timing provenance and failure injection.
Do not merge role-specific database setup or hide force-drop/cancellation cleanup.
Do not import production calculations, transition decisions, or schema constants
into golden expected answers when that makes implementation and oracle agree by
construction. Preserve integration versus unit test separation.

**Verify**

Run each changed test file in its existing runner/config; ensure it actually ran
and was not skipped. Keep duplication exclusions/coverage thresholds intact.
Any baseline reduction must reflect eliminated duplication, not a wider exemption.
No wholesale snapshot regeneration or new mocking architecture.

### R15 — Coverage closure, retained areas, and final verification

Complete the full coverage pass even where the scan found no candidates:

- API controllers/guards/use cases, runtime construction and config.
- All worker execution, transport, runtime and support code.
- Every database sub-area, SQL interfaces, migration ownership and test support.
- All 12 packages, exports, schema generators, fixtures and test configuration.
- Infrastructure runners, validators, shell scripts, ECS assets, exercises,
  observability, CI workflows, root build/lint/test configuration and current docs.

Use the inventory and repository file listing to mark each area reviewed. Inspect
unflagged families for nested ternaries, boolean-parameter combinations, repeated
state decisions, ambiguous names, over-fragmented wrappers, dynamic casts, and
embedded code. Add concrete newly found occurrences to the ledger before editing.
Do not interpret this as permission for unrelated features or architecture changes.

**Initial retention candidates, not blanket exemptions**

- Database workspace transaction/client hygiene, bounded JSON traversal,
  workspace-purge phase ordering and control-ledger coordination: preserve the
  visible proof unless a measured private extraction improves locality.
- Engine/model/SDK JSON and checkpoint validators: different limits, versions,
  and error contracts; do not unify by visual resemblance.
- Core-node validation diagnostics; catalog release/cohort history; contracts'
  per-surface schema tables and generated artifacts.
- Observability sanitization and failure isolation, existing local policy constants.
- Recent Q9 context projection, graph traversal, secure body cleanup, authenticated
  command context, and SSE cleanup fixes.
- Small shell release/bootstrap scripts, explicit per-role SQL provisioning,
  root build configuration and pinned image declarations.
- ECS external-platform validator's existing named assertions and observability
  validator's straightforward structure.

A retention record must say what complexity the code is protecting and why the
proposed alternative would add indirection or risk. “Previously approved,”
“tests pass,” or “under the limit” alone is not enough.

## Verification and completion contract

### Per slice

1. Read callers/tests and record observable behavior before editing.
2. Characterize missing policy/race/error-order behavior.
3. Implement one coherent family, including all its actual occurrences.
4. Run the narrowest relevant tests, build/typecheck, and applicable
   architecture/contracts checks. Inspect the resulting diff for unrelated churn.
5. Record a short before/after explanation: which reading burden disappeared,
   where ownership lives, and whether interface/parameter/file complexity grew.
6. Do not continue an abstraction whose interface is becoming as complicated as
   the code it replaces. Keep or revise the local implementation and explain why.

Example command forms (resolve current package scripts before execution):

- Unit: `pnpm --filter @pertexo/workflow-engine exec vitest run test/operation-risk-branches.test.ts`.
- Database integration:
  `pnpm --filter @pertexo/database exec vitest run --config vitest.integration.config.ts test/coordinator-run-store-observations.integration.test.ts`.
- Infrastructure:
  `node --test infrastructure/report-risk-coverage.test.mjs`.

Integration checks require the documented local services and role setup. Never
point readability tests at a shared/production database or silently skip required
integration verification. Follow `docs/operations/local-quality-verification.md`
for service-backed qualification.

### Final implementation gate

- Every baseline C/F candidate has a concrete disposition; every area has an
  explicit reviewed/retained/changed record. New same-family findings are included.
- Re-run the inventory methodology on the final source and reconcile changes.
  A reduction in OR/function counts is informative, not a pass/fail criterion.
- No behavior/compatibility drift, weakened validators, rewritten migrations,
  new forbidden imports, expanded exports, lowered thresholds or hidden cleanup.
- Run `pnpm check` and one stable, fresh `pnpm quality:local` qualification
  for the final implementation, following the operational guide. Record source identity,
  command, actual passed/failed/skipped counts, evidence paths and service-backed
  results. Do not reuse evidence created before the final code edits.
- An independent read-through must be able to explain the changed rules,
  failure precedence and ownership from the code. Automated checks alone do not
  close a readability task.
- Report all remaining limitations honestly. A blocked required item means
  partial completion, not “everything is now clean.”

Suggested sequence: R00 → R01/R04/R13 small policy slices → R02/R03/R12 invariant
slices → R07/R08/R09 orchestration slices → R05/R06/R10/R11 lifetime slices →
R14/R15 closure. Tests accompany each slice; they are not postponed to R14.
Parallelize only independent ownership; keep cross-package policy, shared files,
integration and final review with one coordinator.

No commit or push is authorized by this planning handoff. If later requested,
follow `AGENTS.md` for coherent Conventional Commits, staged-diff review and
upstream checks. Preserve all pre-existing dirty work.

## Prompt for the implementing AI

> Implement `docs/backend-readability-plan.md` against the current working tree.
> Read `AGENTS.md`, `CONTEXT.md`, relevant ADRs and the plan before changing code.
> Preserve existing Q9 fixes and unrelated dirty work. Start with R00's ledger and
> the keyed candidates in `docs/backend-readability-inventory.json`. Work through
> every family and area, not only the highlighted examples. Improve actual
> readability using small, domain-named private phases, visible cleanup ownership
> and intentional constants; do not add generic frameworks or chase line counts.
> Characterize uncertain behavior before refactoring, preserve validation/error/
> transaction/race ordering and all security/compatibility/bounded-work contracts,
> and run the named verification at the owning interfaces. Retained candidates need
> a concrete reason and blocked work must remain visibly incomplete. Do not claim
> repository-wide completion until R15 and fresh final qualification are complete.
> Do not commit, push, deploy, rewrite migrations, or change architectural/public
> contracts without separate authorization.
