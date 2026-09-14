# Whole-codebase quality implementation progress

Date started: 2026-09-12. This is live implementation tracking for the plan in
[`whole-codebase-review/implementation-order.md`](whole-codebase-review/implementation-order.md).
The audit ledgers remain historical review evidence and are not rewritten to
claim implementation completion.

## Current summary

- Baseline: branch `feat/whole-codebase-quality-plan`, starting commit
  `fb0650174dff1c9ecdf4e91c620b442f2ea1160f`.
- Q01 through Q42 are verified complete locally. Q01's complete stable-source
  coverage producer and consumer regeneration now pass, including provenance
  for all 24 standalone cohorts and zero unreviewed residual branches. Q04's
  coupled PF-03 entrypoint evidence is therefore also final. A fresh full
  `pnpm quality:local` qualification passes all 21 required cohorts with stable
  start/end source identity, validated reports, owned cleanup, and only the
  three declared AWS-only control-ledger exclusions.
  No status below treats a review disposition (`FIX`, `TEST`,
  `REFACTOR`, `CONDITIONAL`, or `KEEP`) as completion.
- No implementation commit, push, PR, deployment, or live external operation
  has been performed.

## Work-package status

| Package | Status | Current evidence / next gate |
| --- | --- | --- |
| Q01 | **Verified complete** | Git override isolation, trusted cohort validation, retryable lock cleanup, output backpressure, nested SSE cleanup budgets, bounded capture, timeout truth, exact source spans, complete Istanbul record validation, exact inventories for all 15 risk cohorts, and pre-test coverage provenance pass focused tests. The complete stable-source producer binds 24 cohorts; regenerated evidence accounts for 691 source files with zero unmapped runtime files, and the risk report records 405 reviewed / 0 unreviewed branches across 186 selected files and 7,500 coverable lines. |
| Q02 | **Verified complete** | WQ-114–WQ-128 pass worker unit/typecheck, strict touched-file lint, isolated outage proofs, and the complete 20-file / 44-test worker integration cohort. Coordinator fixtures expose a narrow owned interface and Schedule fixture mechanics are separated from scenario assertions. |
| Q03 | **Verified complete** | WQ-018–WQ-021 and PF-02 pass the full 108-test observability suite, build/typecheck, focused API/worker consumers, built-export contracts, and the operator/restore diagnostic failure matrices. |
| Q04 | **Verified complete** | WQ-046–WQ-050, PF-01, telemetry/worker shutdown ownership, five app-owned entrypoint seams, compiled signal/process fixtures, and strict entrypoint cohorts pass. PF-03's five entrypoint cohorts are included in the final 24-cohort stable-source producer manifest and regenerated source inventory. |
| Q05 | **Verified complete** | WQ-055–WQ-060 pass 765 API unit tests, typecheck/build/lint, compiled explicit/signal lifecycle tests, and the scoped 8-test Redis reconnect integration. |
| Q06 | **Verified complete** | WQ-106–WQ-110 pass 410 worker unit tests, 300 database unit tests, focused typecheck/build/lint, and 142 exact production-attempt regressions. |
| Q07 | **Verified complete** | WQ-111–WQ-113 and the WQ-079 worker extension pass 442 worker unit tests, 71 focused preview tests, 3 real transport/registry integration tests, and the 5-test database preview fence lifecycle. |
| Q08 | **Verified complete** | WQ-100–WQ-101 pass 494 worker unit tests, the 74-test focused provider/HTTP/preview/coordinator/trigger matrix, typecheck/build/lint, and the complexity ratchet. |
| Q09 | **Verified complete** | WQ-037–WQ-045 and PF-05 pass the full engine suite, built-export gate, and real PostgreSQL/Redis coordinator proofs. WF-S01 was removed after its compatibility gate. PF-06 remains unchanged pending Q40's measurement gate. |
| Q10 | **Verified complete** | WQ-206–WQ-211 and PF-04 pass fresh/prior-head migrations, the full 303-test database unit and 428-test PostgreSQL integration suites, direct-role boundary matrices, the five-table v4/v7 artifact-reference matrix and its two-client deletion race, and the worker schedule/notification consumers. |
| Q11 | **Verified complete** | WQ-193–WQ-202 pass database typecheck/build, 89 files / 321 unit tests, the full 81-file / 433-test PostgreSQL integration suite, the 7-file / 39-test final changed integration cluster, and scoped strict ESLint. |
| Q12 | **Verified complete** | WQ-181–WQ-185 pass 93 files / 357 database unit tests, the full 81-file / 446-test PostgreSQL integration suite, 10 files / 73 focused coordinator integration tests, typecheck/build, scoped strict ESLint, and repository formatting. |
| Q13 | **Verified complete** | WQ-064–WQ-067 pass API typecheck/build, scoped strict ESLint, and 12 files / 180 connection plus bootstrap tests. |
| Q14 | **Verified complete** | WQ-057 extension and WQ-085/WQ-091–WQ-099 pass worker typecheck/build, 56 files / 601 unit tests, both coverage cohorts, 8 compiled process tests, 109 observability tests, and scoped strict ESLint. |
| Q15 | **Verified complete** | WQ-102–WQ-105 pass worker typecheck/build, 58 files / 739 unit and compiled-process tests, both coverage cohorts, 44 Resend client regressions, and scoped strict ESLint. |
| Q16 | **Verified complete** | WQ-129–WQ-139 pass database typecheck/build, 95 files / 494 unit tests, the full 81-file / 453-test PostgreSQL integration suite, complete 68-table schema ownership, and all 24 built-package consumer cases. |
| Q17 | **Verified complete** | WQ-001–WQ-007 pass 37 rate-limit, 51 SDK, 77 catalog, 97 workflow-model, 83 focused API unit, and 14 real Redis integration tests plus all package coverage, build, type, lint, import, and export gates. |
| Q18 | **Verified complete** | WQ-008–WQ-013 and PF-07 pass bounded node/graph admission, evaluator lifecycle, mapping, compatibility, coverage, and downstream owner gates. |
| Q19 | **Verified complete** | WQ-014–WQ-017 pass 11 files / 76 tests in ordinary and shuffled order, package coverage, typecheck/build, and scoped strict ESLint. |
| Q20 | **Verified complete** | WQ-022–WQ-027 pass 10 files / 333 tests in ordinary and shuffled order, package coverage, typecheck/build/lint, downstream owner tests, and local architecture/export gates. Provider integration remains separately gated and was inspected/skipped. |
| Q21 | **Verified complete** | WQ-028–WQ-036 pass 13 files / 385 tests in ordinary and shuffled order, package coverage, typecheck/build/lint, downstream worker/API owner tests, and local architecture/export gates. External provider I/O was neither needed nor performed. |
| Q22 | **Verified complete** | WQ-051–WQ-054 pass 16 files / 70 tests in ordinary and shuffled order, package coverage, typecheck/build/lint, deterministic generation plus OpenAPI lint, the full 843-test API owner suite, and local architecture/export gates. |
| Q23 | **Verified complete** | WQ-061–WQ-063 pass 84 files / 883 API tests in ordinary and shuffled order, all API coverage cohorts, typecheck/build/lint, 22 real PostgreSQL/S3Mock transfer cases, and local architecture/export gates. |
| Q24 | **Verified complete** | WQ-068–WQ-074 plus the WQ-064/WQ-065 identity extensions pass 18 files / 254 focused tests in ordinary and shuffled order, 84 files / 953 API tests, all four API coverage cohorts, contract generation/OpenAPI lint, typecheck/build, scoped strict ESLint, and local architecture/export gates. The disposable real-API lane was fixture-hardened and inspected but remains environment-gated and was not executed. |
| Q25 | **Verified complete** | WQ-075–WQ-078 plus the WQ-065 schedule/webhook extensions pass 13 files / 135 focused tests, 93 files / 1,056 API tests in ordinary and shuffled order, all API coverage cohorts, contract and local architecture/export gates. The disposable PostgreSQL/KMS lane remains explicitly gated and was not executed. |
| Q26 | **Verified complete** | WQ-079–WQ-081 pass 5 files / 66 focused API tests, 93 files / 1,099 API tests in ordinary and shuffled order, all API coverage cohorts, 10 real PostgreSQL preview cases, 26 worker runtime regressions, typecheck/build/lint, and local architecture/export gates. |
| Q27 | **Verified complete** | WQ-082–WQ-084 plus the WQ-064 telemetry extension pass 10 files / 137 focused unit tests in ordinary and shuffled order, 94 files / 1,166 API tests in both orders, all API coverage cohorts, 12 real lifecycle/version HTTP cases, the disposable compatibility-rollout proof, 23 database authoring integration cases, and scoped type/build/lint/format/architecture/export gates. |
| Q28 | **Verified complete** | WQ-085–WQ-090 pass 13 files / 172 focused tests, including the nested-read and public-projection SSE cleanup regressions; the final full API passes 97 files / 1,277 tests. All API coverage cohorts, typecheck/build, scoped strict lint/format, and local architecture/export gates pass. |
| Q29 | **Verified complete** | WQ-140–WQ-146 pass 97 files / 522 database unit tests in ordinary and shuffled order, the full 82-file / 469-test PostgreSQL integration suite, the final 7-file / 54-test changed integration cluster, database/API typecheck and build, scoped strict lint/format, and local architecture/export gates. |
| Q30 | **Verified complete** | WQ-147–WQ-153 pass 99 files / 539 database unit tests in ordinary and shuffled order, the full 82-file / 479-test PostgreSQL suite and integration coverage, the final 8-file / 48-test compatibility/authoring cluster in ordinary and shuffled order, cross-package checkpoint conformance, typecheck/build/lint/format, and local architecture/export gates. WQ-147 keeps full retained-history validation; optimization remains correctly deferred to Q40's qualified measurement gate. |
| Q31 | **Verified complete** | WQ-154–WQ-162 pass 101 files / 555 database unit tests in ordinary and shuffled order, the full 83-file / 488-test PostgreSQL suite and integration coverage, the final 7-file / 33-test trigger/schedule cluster in ordinary and shuffled order, downstream worker unit owners, typecheck/build/lint/format, and local schema/architecture/export gates. WQ-161 keeps recurrence unchanged pending Q40's qualified measurement gate. |
| Q32 | **Verified complete** | WQ-163–WQ-170 pass 103 files / 597 database unit tests in ordinary and shuffled order, the full 83-file / 497-test PostgreSQL suite and integration coverage, the final 12-file / 95-test value/reader/admission/event/transport cluster in shuffled order, database/API/worker typecheck and build, downstream worker unit owners, scoped strict lint/format, and local schema/architecture/export gates. |
| Q33 | **Verified complete** | WQ-171–WQ-177 pass 106 files / 681 database unit tests, the full 83-file / 502-test PostgreSQL suite and integration coverage, the final 15-file / 114-test operator/artifact unit cluster and 10-file / 79-test integration cluster in ordinary and shuffled order, owner builds/typechecks, downstream API/worker/operator tests, scoped strict lint/format, and local schema/architecture/export gates. |
| Q34 | **Verified complete** | WQ-178–WQ-180 pass 108 files / 726 database unit tests, the full 83-file / 511-test PostgreSQL suite and integration coverage, the final 3-file / 57-test unit cluster and 2-file / 21-test integration cluster in ordinary and shuffled order, downstream API/worker owner tests, typecheck/build/lint/format, and local schema/architecture/export gates. |
| Q35 | **Verified complete** | WQ-186–WQ-192 pass 110 files / 746 database unit tests, the full 83-file / 522-test PostgreSQL coverage suite, the final 8-file / 51-test integration cluster in shuffled order, owner and downstream tests, typecheck/build/lint/format, and local schema/architecture/export gates. |
| Q36 | **Verified complete** | WQ-203–WQ-205 pass 112 files / 759 database unit tests in ordinary and shuffled order, the full 85-file / 525-test PostgreSQL coverage suite, the final 4-file / 36-test historical/OIDC/role cluster in shuffled order, typecheck/build/lint/format, and local schema/architecture/export gates. |
| Q37 | **Verified complete** | WQ-212–WQ-216 pass 174 infrastructure tests, all 24 built-package consumers, documentation validation, database coverage merge, repository build/typecheck/format, and scoped strict ESLint. Complexity and duplication correctly reject outstanding findings from later unfinished packages; Q37's own identities and evidence shapes pass their ratchets. |
| Q38 | **Verified complete** | WQ-217–WQ-219 pass all 58 ECS infrastructure tests, semantic deployment/evidence validation, deterministic rendering, both real local rendered-task smoke cohorts, repository build/typecheck/format, documentation validation, and scoped strict ESLint. |
| Q39 | **Verified complete** | WQ-220–WQ-222 pass 22 exercise tests, all 24 alert rules plus multi-series rule fixtures, 112 observability and 100 retention tests, the worker startup/flush cohort, and the disposable exact-pinned three-writer metric pipeline. No HTTP load or deployed telemetry operation was performed. |
| Q40 | **Verified complete** | WQ-228–WQ-230 pass 64 benchmark contract/lifecycle tests, schema-v5 manifest validation, and a complete source/build-stable eight-scenario disposable qualification with scoped SQL, process, plan, runtime and cleanup evidence. PF-06 remains KEEP: measurement found no justified optimization or stable latency budget. |
| Q41 | **Verified complete locally** | WQ-231 adds explicit ordinary-quality owners for architecture, built exports, and local runner/performance contracts plus a 7-test semantic policy validator. All three gates and 106 combined contract tests pass locally; hosted exact-revision execution and branch protection remain external evidence. |
| Q42 | **Verified complete** | WQ-232 reconciles the authoritative blueprint with ADR 011's strong opaque public `If-Match`, internal numeric CAS, publication-time desired projections and asynchronous activation convergence; dated status, codebase-map, governance, complexity, release-gate and test-confidence pointers are current. Documentation validation passes 18 tests and 886 local links. |

## Final local qualification

- The qualification runner now gives every run a collision-resistant
  `pertexo-local-quality-*` Compose identity. Destructive SSE testing requires
  an explicit disposable-target flag, the exact owned Compose project, a local
  Redis URL/port match, and a successful Compose port lookup before stopping
  Redis. The same ownership contract is mandatory in CI, so omission becomes a
  policy-test failure rather than a silently pending recovery proof.
- Full qualification passes source quality, the 24-cohort coverage producer,
  isolated services and migrations through `0089`, all seven mutation
  red/green checks, the eight-scenario performance qualification, deployment,
  immutable-image, exercise, compatibility, and cleanup gates. Its validated
  service reports contain 6 locally executable artifact-store tests plus three
  explicit AWS-only exclusions, 1 queue test, 525 database tests, 44 worker
  integration tests, 64 API integration tests, 21 worker recovery tests, and
  one test in each SSE resilience, worker transport resilience, API
  compatibility, and database compatibility cohort; none is pending.
- Database integration deliberately refreshes the unit coverage input used for
  the combined 196-file database report, and worker integration refreshes the
  run-linked risk report. Full qualification now reseals the standalone
  coverage-producer manifest in its final cleanup cohort, after both writers,
  preserving the post-run `pnpm coverage:evidence` contract instead of leaving
  internally successful but stale provenance.
- Qualification remains local evidence. Hosted CI, branch protection, the
  three AWS S3 Object Lock/policy behaviors, deployment, provider calls, and
  live exercise traffic remain explicitly outside this implementation run.

## Q01 evidence log

Passing focused commands after the current Q01 and SSE follow-up edits:

```text
pnpm --filter @pertexo/api exec vitest run --config vitest.config.ts \
  test/workflow-runs/sse-transport.test.ts
node --test infrastructure/generate-coverage-evidence.test.mjs \
  infrastructure/report-risk-coverage.test.mjs

64 tests passed; 0 failed, skipped, cancelled, or todo.
```

Implemented and directly exercised:

- Explicit snapshot Git operations, candidate enumeration, and source identity
  strip inherited `GIT_*` repository/index/config overrides. Disposable control
  repository HEAD, index, configuration, status, and separate index remain
  unchanged.
- Qualification requiredness and report expectations derive from
  `LOCAL_QUALITY_COHORTS`; downgrade, unknown inventory, failed outcome, stale
  source, and malformed report evidence are rejected.
- Lock setup removes incomplete ownership on write/close failure. Release is
  owner-verified and retryable after read/removal failure; a replacement owner
  is never deleted.
- Command evidence pauses owned output until terminal and log sinks drain,
  bounds captured output at an explicit 16 MiB failure limit, preserves trailing
  bytes, and enters owned cleanup on command deadline.
- Mutation timeouts cannot return success, retain failed termination evidence,
  and retry supervisor-owned cleanup.
- Reviewed-branch fingerprints use exact bounded source bytes and correct
  same-line absolute columns, so literal whitespace changes remain semantic.
- Missing/mismatched/invalid Istanbul counters, including an entirely empty
  file record, and failed/pending/malformed test results are rejected rather
  than becoming zero-denominator success. Every one of the 15 risk cohorts has
  an independently enforced exact inventory; the three exhaustive source-tree
  cohorts are enumerated from their owned source directories.
- `coverage/coverage-producer-manifest.json` is now produced by
  `pnpm test:coverage` and binds a pre-test source witness, exact source, cohort
  coverage/result bytes and production intervals, runtime/tool identity, and
  the risk report. A standalone reseal rejects both source changed since the
  witness and artifacts produced before it. The inventory producer validates
  this manifest and rechecks inputs for concurrent changes before writing.
- SSE transport races each pending frame pull against its owning abort signal.
  Authorization loss therefore enters the outer bounded cleanup immediately,
  ends the response within the configured budget, and retains eventual nested
  producer cleanup without allowing an inner `return()` to hold the HTTP
  transport open indefinitely.

Final stable-source verification:

- `pnpm test:coverage` passes the complete producer path and binds 24 standalone
  cohorts to source fingerprint
  `sha256:b460ce440131ff15831907d051f0b062f7f1e943ad538925a4c2bd6872c7d01c`.
  Service-gated database integration coverage remains independently owned by
  local qualification instead of being falsely claimed by this ordinary-CI
  producer.
- The risk report's 30 contract tests pass and it records 405 reviewed and zero
  unreviewed uncovered branches across 186 selected files and 7,500 coverable
  lines. Reviews retain 298 defensive, 63 unreachable, 40 generated, and four
  run-linked integration dispositions.
- `pnpm coverage:evidence` passes 13 producer/consumer contract tests and
  regenerates an inventory of 691 source files: 287 measured runtime, 28
  measured declaration, 322 source-mapped owner-suite, zero unmapped runtime,
  and 54 build/type/export-contract files. The two explicitly reported
  unselected runnable helpers are `apps/operator-command/src/run.ts` and
  `apps/retention/src/run.ts`; PF-03 owns the five application `main.ts`
  entrypoints rather than claiming every helper as an entrypoint cohort.

## Q02–Q03 evidence log

- Coordinator integration consumers now import their actual dependencies and
  use one narrow frozen fixture interface for owned identities, service control,
  scoped queries and lifecycle. JSON remains validated at its retained fixture
  seam, parallel recovery captures stable spies instead of late mutable
  properties, and no broad package/runtime re-export remains.
- Schedule database creation, migration, compatibility activation, scoped role
  queries, Redis namespace, queue and teardown ownership live in a dedicated
  fixture while the integration file retains scenario resources and assertions.
  The fixture skips the already-current compatibility release and registers
  every acquired owner before fallible work.
- The complete worker integration cohort passes 20 files / 44 tests. Focused
  outage reruns also pass failure-notification reconstruction with a test-owned
  two-second consumer drain, Retry/Wait Redis failure and recovery, preview
  delivery persistence, and direct Schedule reconciliation. Worker typecheck
  and strict lint over every touched coordinator/Schedule file pass.
- Worker recovery admission applies its remaining overall budget to every
  command and inspection, and refuses retries after expiry. The preview crash
  fixture registers each wait before use, bounds retained output/messages,
  contains predicate/parser failures, caches owned termination, and proves child
  exit before state release. The two focused suites pass 7 tests plus worker
  typecheck.
- Observability normalization is total across hostile and revoked proxies,
  descriptor-based traversal never invokes accessors, secret/reserved keys are
  rejected before values, and one global 500-entry budget prevents multiplicative
  breadth. Nest text is redacted before its shorter display boundary.
- Asset claims are split by structure, textual linkage/inventory, provisioning,
  emitters, and label policy. Real providers and instrumentation patches attempt
  all cleanup owners. HTTP export assertions identify each request scenario, and
  every invalid transport measurement proves all harness collections stay empty.
- `pnpm --filter @pertexo/observability test` passes 108 tests; observability
  build/typecheck, repository build, 33 API bootstrap tests, and 30 focused worker
  adapter/bootstrap tests pass.
- The PF-02 deep export is browser-excluded and covered by built-export contract
  tests. Operator and restore failure paths preserve the initiating failure,
  retain diagnostic/cleanup failures in order, and attempt every owner; their
  focused suites pass 18 and 9 tests respectively with typechecks.

## Q04 evidence log

- Retention maintenance owns eight child promises behind a local abort signal.
  A fatal child aborts siblings and the group drains every settlement before it
  rejects upward; the top-level replica/maintenance supervisors therefore
  cannot release shared resources around active work. Focused regressions hold
  a child, delayed readiness, active purge, and replica-failure paths and prove
  cleanup remains blocked until the test-owned work settles.
- Maintenance and replica cancellation require both an aborted signal and exact
  reason identity. Undefined adapter rejections are recorded and retried;
  distinct errors racing with shutdown still execute the failure policy.
- Restore inventory tests cover two workspaces and three artifacts across exact
  cursors/pages, independent tuple bytes and SHA-256, empty inventory,
  non-progress, page exhaustion, and abort between pages.
- Operational configuration tests cover all ten operator translations and
  frozen commands, individual dry-run/timeout/identity/JSON bounds, production
  telemetry, exact recovery capacity, and every artifact/ledger principal and
  bucket collision. The mapper has one private audit identity and an explicit
  exhaustive switch.
- Retention metric tests pin all 15 instrument units and exact failure, replica,
  purge, rerun, schedule, transient-row, batch, preview, and run-artifact
  values/attributes. Each of eight independently supervised operations proves
  a controlled 125 ms interval records exactly 0.125 seconds. Fixed microtask
  flushing was replaced by bounded observation of the intended call barrier.
- API, worker, operator, recovery, retention, lifecycle-command, and
  observability all pass build, typecheck, and complete unit suites: 682, 358,
  60, 43, 100, 27, and 108 tests respectively. The five new entrypoint cohorts
  pass their configured statement/branch/function thresholds; lifecycle-command
  reports 95.55% statements and 97.61% branches. Q01's final stable-source
  producer now includes all five app-owned entrypoint cohorts, and the
  regenerated evidence inventory validates their exact artifact and result
  hashes.

## Q05 evidence log

- Unknown public errors are normalized through guarded own data descriptors;
  hostile proxies, throwing accessors/mappers, revoked proxies, and invalid
  framework statuses all fail closed without reflecting private values.
- Rate-limit metric recording is diagnostic only across allow, refuse,
  fail-open, and fail-closed paths. A throwing recorder cannot admit rejected
  work, replace the stable public problem, or invoke a controller.
- One API-owned coordinator marks drain before transport disposal, then closes
  all registered resources in reverse acquisition order. It catches synchronous
  throws and rejections (including `undefined`), caches concurrent close, waits
  for held owners, preserves ordered failures, and leaves explicit-close signal
  listeners released. Compiled SIGTERM children prove both normal signal
  termination and nonzero cleanup failure after every owner was attempted.
- Readiness rechecks the monotonic drain state after pending dependency work.
  Platform tests now independently cover deployed configuration constraints,
  conflict fields, issue/retry bounds, request cancellation/listener cleanup,
  exact availability outcomes and duration, all SSE paths, controller-policy
  discovery, artifact/lifecycle routes, and primitive JSON coercion.
- Redis reconnect fault injection now cuts only the limiter's connection through
  a fixture-owned local TCP proxy; a direct sentinel remains usable. Allocation,
  connect, ping, construction, and cleanup-failure ownership have unit tests.
  The real scoped integration passes 8 tests against the local Redis service.
- Verification: `@pertexo/api` 80 files / 765 unit tests, typecheck, build, and
  scoped ESLint pass; the focused Redis integration passes 8 tests.

## Q06 evidence log

- Dispatch authorization now reserves one attempt-local `marking` state before
  awaiting persistence, never reopens the capability after an uncertain marker
  failure, and exposes provider work only after the durable marker succeeds.
  Concurrent success and rejection tests prove that exactly one marker call is
  possible while independent execution environments remain independent.
- Heartbeat acquisition is inside the handler's owned failure boundary. Runtime
  and capability shutdown defer synchronous closers, settle every sibling,
  preserve the primary failure with ordered cleanup failures, cache the exact
  close result, and fence readiness both before and after pending checks.
  Executor success and failure both wait for late heartbeat settlement; a
  cancellation-ignoring executor cannot erase heartbeat or durable completion
  truth.
- Artifact runtime ownership is isolated in a dedicated lifecycle module. It
  owns iterator return, partial writes, upload stream destruction/closure, and
  temporary-directory cleanup on every exit. Every acquired chunk is cleared,
  including cancellation, overflow, zero-progress, and write-failure cases;
  abort waits for pending iterator/write/upload work instead of abandoning it.
- Provider connection resolution rechecks cancellation after rate admission,
  database lookup, and decryption, clears decrypted secret bytes on late abort,
  and propagates the signal through tenant-scoped resolution/currentness
  transactions. Hostile adapter failures remain total and do not become false
  availability outcomes.
- Attempt preparation now names graph projection, structured-scope validation,
  identity pinning, and upstream derivation. Exact condition, switch, nested,
  parallel, merge, and iteration ancestry is accepted; missing, forged,
  duplicated, or out-of-order scope evidence is rejected. The outcome suite has
  a behavior-based file name and its mutation owner was updated.
- Verification: the five focused production-attempt suites pass 142 tests;
  `@pertexo/worker` passes 45 files / 410 tests plus typecheck, build, and scoped
  ESLint; `@pertexo/database` passes 85 files / 300 tests plus typecheck and
  build; the mutation-sensitivity infrastructure suite passes 8 tests.

## Q07 evidence log

- The database preview adapter now projects one exact lease authority and
  forwards the optional connection fence and provider dispatch binding alone,
  together, or absent. The real database lifecycle rejects disabled/rotated
  connections and mismatched existing bindings without marking dispatch; the
  handler maps only genuine durable error instances to provider evidence.
- Preview dispatch uses the supervisor's execution signal and reserves one
  local `marking` state before its marker await. Pre-aborted execution cannot
  start invocation, concurrent marker callers cannot both acquire permission,
  and a deadline during marking cannot admit the later provider call.
- The supervisor owns one observed heartbeat loop and one observed invocation.
  It rechecks stop after delay and heartbeat awaits, contains delay/result
  failures, reports transport, deadline, and lease winners before aborting
  dependent work, and caches shutdown. Deadline truth can commit while a late
  invocation is still draining, but handler/runtime release waits for ignored-
  abort invocation and heartbeat resolve/reject settlement.
- The preview invoker resolves the exact retained compatibility release and
  validates definition config version plus executor identity before mapping or
  execution. A real core-registry regression rejects `configVersion: 999`.
  Invoker close refuses new work, waits active invocation, shuts down its owned
  expression evaluator once, and is exercised explicitly by every unit and
  integration owner.
- Completion now derives one bounded terminal outcome, performs one durable
  completion call, and records telemetry only after first commit. Fixture
  execution deadlines respect ADR-016, queue delivery is structurally valid,
  identity fields are exact, timing tests use controlled clocks/start barriers,
  and hostile/same-name rejections fail closed without fabricating authority.
- Verification: four focused preview suites pass 71 tests; `@pertexo/worker`
  passes 47 files / 442 tests plus typecheck, build, scoped ESLint, formatting,
  and the repository complexity ratchet. Real local preview transport and
  registry paths pass 3 tests; the database preview attempt lifecycle passes 5
  integration tests; `@pertexo/database` passes 85 files / 300 unit tests plus
  typecheck and build.

## Q08 evidence log

- Shared provider tracing captures one business promise independently of the
  optional trace wrapper. A trace that throws or rejects before its callback,
  after invoking it, or after returning a distinct promise cannot rerun work or
  replace the exact success/rejection. Unexpected duplicate callbacks reuse the
  same promise, and rejected diagnostic promises are observed.
- Failure classification, request/rate-limit counters, duration recording,
  individual span attributes, status, and end are independently best-effort.
  Hostile/revoked rejection values fall back to bounded internal labels while
  their original identity remains the business rejection.
- HTTP uses the same single-execution rule for both its local adapter and
  production active span. Success preserves inline/artifact classification;
  every failed/retry/canceled/unknown decision, throwing/non-finite clock,
  annotation/rate-limit failure, and span lifecycle failure is contained.
- Email and Slack retain distinct provider policies and named instruments.
  Request versus rate-limit counters are independently asserted, rate-limit is
  absent on success, and real output/error sentinels prove message IDs, channel
  values, email content, credentials, and private errors never enter labels.
- Preview tests now cover false versus absent optional labels and all four
  reconciliation decisions. Coordinator tests cover positive, zero, skew,
  NaN, and both infinities. A named trigger harness pins scan, occurrence,
  duration, lag, reconciliation, and healthy/throttled/degraded instruments;
  throwing trigger metrics cannot change scanner failure/recovery state.
- Provider telemetry construction occurs under the existing node-runtime
  rollback owner. Trigger telemetry is now constructed before database/queue
  acquisition, so constructor failure cannot strand those resources.
- Verification: nine focused telemetry/caller suites pass 74 tests;
  `@pertexo/worker` passes 49 files / 494 tests plus typecheck, build, scoped
  ESLint, formatting, `git diff --check`, and the repository complexity ratchet.

## Q09 evidence log

- The structured stop pass now retains running For Each body invocations and
  active ordinal identity until durable outcomes arrive. Pending, ready, and
  waiting work stops with one explicit cancellation-over-deadline decision;
  nested loop controls remain protected until their active children settle.
  No later ordinal is admitted after either control activates, iteration budget
  and collection identity remain stable, and late `outcome_unknown` truth wins
  over deadline or cancellation.
- Checkpoint traversal uses tagged value/exit frames; timestamps reject invalid
  calendar normalization; outer observation windows admit only ordinary dense
  data arrays without invoking accessors or caller-controlled iteration; and
  identical completed-output descriptors canonicalize while conflicts reject.
  Empty iteration paths use root scope and hostile/revoked error objects remain
  total at evaluator, registry, and executor boundaries.
- The former dense pin validator and loop-key expressions are split around
  domain phases. Scenario-bundled For Each, input, scoped-attempt, and risk
  tests now have independent names and fixtures, with production/testing imports
  taken from their actual public facades rather than re-exported by a test file.
- The WF-S01 compatibility gate found no production, workspace, built-output,
  or supported external consumer of `stop_scheduling`. The impossible testing-
  facade union member was removed, an exhaustive compile-time consumer was
  added, and `pnpm built-exports:check` validates all 15 built consumer cases.
  PF-06 remains a KEEP-after-gate item until Q40 supplies its prescribed
  benchmark runner, profiles, and two-run threshold evidence.
- Real PostgreSQL/Redis coordination covers normal For Each completion,
  cancellation between batches, cancellation with two physically leased body
  attempts, and deadline expiry followed by a late fenced unknown outcome.
  Every interim revision commits through a fresh coordinator, reserves no later
  ordinal, retains running truth, and finishes with the required canceled or
  unknown status. A separately compiled `core.wait` workflow genuinely
  suspends, then commits simultaneous database-owned deadline and cancellation
  facts as `node.canceled` plus `run.canceled`, with wait fields cleared, no
  timed-out event, no successor attempt, and stable redelivery.
- That authentic Wait proof exposed and fixed a separate fail-closed database
  validator defect: before a stop transaction persists, a suspended Wait owns
  output through a succeeded attempt and a waiting node. Output ownership now
  recognizes only a status-validated prior `node_wait` transition to canceled
  or timed out; all other physical status checks are unchanged.
- Verification: `@pertexo/workflow-engine` passes 30 files / 366 tests,
  typecheck, build, scoped ESLint, and its coverage cohort at 94.34% statements,
  90.44% branches, 96.81% functions, and 95.01% lines. The two worker integration
  files pass 3 real-service tests; the affected database node-attempt integration
  passes 5 tests; worker/database typechecks and database build pass. The global
  duplication gate still reports accumulated non-Q09 application/test clone
  families and remains a later repository-wide reconciliation gate; it reports
  no new workflow-engine clone family from this package.

## Q10 evidence log

- Forward migrations `0087_workspace_maintenance_rerun_purge.sql` and
  `0088_sql_boundary_integrity.sql` advance the transactional migration head.
  A populated 0086 upgrade proves both migrations apply over pending and
  completed retention/purge rerun states; migration history, serving readiness,
  expected-head fixtures, and schema ownership all identify the new head.
- The effective tenant-row purge now deletes maintenance rerun requests, clears
  node attempt pointers as an atomic pair, removes preview artifact/attempt
  children before previews, clears published workflow pointers before versions,
  and deletes current connection/destination children before their immediate
  parents. The populated, page-size-one maintenance-role proof includes current
  attempts, terminal previews and artifact links, published plus historical
  versions, rotated secrets, versioned destinations, and an actual pending
  operator rerun. It reaches the exact tombstone while preserving hold, lease,
  external-ledger high-water and residual-inventory checks.
- Named nullable CHECKs for catalog, preview identity, wake/deadline state,
  notification configuration/pins, schedules, retention, lifecycle, purge and
  operator completion now evaluate malformed input as false rather than SQL
  unknown. Existing rows are validated without fabricated repair. Direct owner
  tests assert exact constraint names, while runtime fixtures now state genuine
  retry/wait semantics instead of relying on nullable holes.
- Privileged recovery, inventory, transient-reaper, schedule claim/defer,
  lifecycle and purge projection functions reject NULL, zero and out-of-range
  bounds or lease identity before protected reads or mutation. Lifecycle and
  maintenance tests execute through their actual roles; valid min/max calls and
  current leases retain their prior behavior. Function replacements preserve
  grants, RLS/search paths and effective `SECURITY DEFINER` metadata.
- Failure-notification configuration, admission locks and pin validation accept
  the public UUID versions, including application-generated UUIDv7 connection
  IDs, while retaining UUIDv4 and rejecting JSON null, wrong shapes, providers,
  auth types and workspaces. The production connection to email destination,
  version, policy and run-admission path persists the exact v7 pin.
- Artifact-reference locking now recognizes UUIDv7 on every attached execution
  table. Workflow input/output, event payload, checkpoint state, node
  input/output and attempt output/reconciliation accept available v4/v7
  references; every table rejects missing, deleting and cross-workspace v7
  references, while ordinary nested JSON containing a non-reference
  `artifactId` remains valid. A two-client test proves deletion/invalidation
  waits for the reference transaction and the later commit rejects unavailable
  output rather than accepting an orphan.
- Verification: `@pertexo/database` passes typecheck, build, 87 files / 303 unit
  tests, 81 files / 428 PostgreSQL integration tests, and the 68-table schema
  ownership gate. Focused worker schedule execution passes against PostgreSQL
  and Redis; the real dual-region artifact adapter suite passes 2 tests against
  the local object-store service. Static migration-shape tests, fresh-head SQL
  boundary tests, notification admission, connection concurrency/security, and
  lifecycle suites all pass. No commit, push, deployment, or live external
  operation was performed.

## Q11 evidence log

- Destructive retention and workspace purge now acquire the workspace authority
  lock before their final external-ledger freshness check and retain it through
  the destructive step. Real command-coordinator races separately cover input,
  preview, run-artifact and workspace-purge holds: the append is observed
  blocked while destruction owns authority, no hold/effect appears early, and
  the append becomes authoritative only after the destructive owner finishes.
- Maintenance SQL cancellation reaches the active PostgreSQL query, and all
  rollback/release failures discard the checked-out client even when a driver
  rejects with `undefined`. External object-store verification remains outside
  open transactions while the session authority lock preserves ordering.
- Control-ledger cleanup represents absence separately from rejection, retains
  the initiating failure, attempts every cleanup owner, and never reuses a
  contaminated client. Tests observe actual `pg_stat_activity` lock waits
  instead of inferring them from fixed sleeps.
- Retention results distinguish delayed, retained, completed and cleanup-failed
  outcomes. Capacity, references, legal holds, replay lineage and retained
  schedules/configuration remain explicit invariants; final execution purge
  proves webhook delivery/replay/occurrence residue is removed while its
  schedule, trigger configuration, endpoint and secret remain.
- Workspace lifecycle tests are independent and chronologically named, own all
  command cleanup, deterministically expire fencing ownership, and prove late
  restoration. Workspace purge has explicit start/completion/step phases,
  centralized exact page validation, malformed page-end/hash rejection and a
  real two-client replay-lineage foreign-key race won by committed deletion.
- Integration fixtures drain paused promises and close coordinators on every
  exit. Benchmark setup keeps a fixed workload rather than adapting to observed
  performance, and per-test artifact/lifecycle ownership no longer depends on
  shared sequential state.
- Verification: `@pertexo/database` passes typecheck, build, 89 files / 321 unit
  tests, and the full 81 files / 433 PostgreSQL integration tests. The final
  seven changed integration files pass 39 tests; scoped strict ESLint and
  formatting pass. No commit, push, deployment, or live external operation was
  performed.

## Q12 evidence log

- Read-only repeatable-read loads no longer request artifact row locks. Fresh
  completion facts and retained checkpoint locators load through actual
  PostgreSQL read-only transactions when their artifacts are available;
  deleting, deleted and deliberately foreign retained locators fail closed.
  Commit-time ownership locking remains authoritative: an observed concurrent
  invalidation lock race waits and then rejects without advancing checkpoint,
  event or receipt state.
- The optional database-observed schedule metric owns a bounded checkout and
  query. Caller abort, checkout/query timeout, shutdown, missing or invalid
  timestamps and late resolve/reject settlement all return the already durable
  commit without a metric and discard the affected client. A held real query
  proves checkpoint/event/receipt truth is committed before abort, and exact
  replay remains `already_committed`.
- Sticky-control guards and ordered status recognizers now expose their mutation
  semantics directly. Active loop-root lookup uses a scoped invocation index
  while preserving first-match duplicates and exact branch/iteration identity;
  fixed 1/500/1,000 populations plus missing and reordered roots retain the
  original plan rejection rules.
- Persisted fact capacity distinguishes canonical protocol bytes from total and
  maximum PostgreSQL wire storage. Page sizing targets four MiB without adding
  a protocol rejection or breaking numeric-exponent expansion; fixed normal,
  application-oversized and expansion-heavy measurements record peak heap and
  latency, and the expansion case crosses multiple pages in one snapshot.
- Coordinator fixtures validate runner-owned database names, create stores only
  after database/migration setup, use checked-out clients for transactions, and
  attempt every store close/database drop/admin close after partial failure.
  Controlled checkout and actual `pg_stat_activity` lock observations replace
  network-port and sleep inference. CAS/replay tests use explicit delivery
  identity, commit-acknowledgement loss proves one durable result, malformed
  pending-failure and wakeup rows fail closed, and scanner/fresh-store cleanup
  is failure safe.
- Failure-notification coverage is split into independently seeded cases for
  policy pins, disable/fence behavior, secret rotation/recovery uncertainty and
  cancellation exclusion. Shared destination/secret mutations are restored
  after every case, and the cancellation case commits an actual policy-pinned
  transition with zero notification intents or outbox events.
- Verification: `@pertexo/database` passes typecheck, build, 93 files / 357 unit
  tests, the full 81 files / 446 PostgreSQL integration tests, and the focused
  10-file / 73-test coordinator integration cohort. Scoped strict ESLint,
  repository Prettier and `git diff --check` pass. Repository-wide lint and
  complexity reconciliation are not claimed here; accumulated changes in other
  planned packages remain for their owning gates. No commit, push, deployment,
  or live external operation was performed.

## Q13 evidence log

- Connection telemetry now lazily owns one business promise. Synchronous or
  asynchronous tracing failure before or after callback invocation, duplicate
  callbacks, counter/duration failure, hostile clock values and simultaneous
  business rejection cannot rerun work or replace its exact result.
- The API connection runtime uses an awaited factory, records each acquired
  database/encryption owner, cleans partial construction failures, defers every
  close invocation and caches shutdown completion. Synchronous and asynchronous
  failures are aggregated in deterministic owner order; injected encryption is
  not assigned invented ownership, and shared database leases remain verified.
- Destination HTTP transport is separated from its seven typed application
  operations. Both connection controllers use the shared authenticated context
  projection, guarded actor identifiers remain authoritative, destination
  responses explicitly select public fields, and optional destination
  persistence still controls both provider and route registration.
- Management and provider-test scenarios now occupy separate test files around
  one typed fixture. Second authorization failures cover missing, inactive,
  downgraded and suspended access; credential decoding, provider availability,
  dispatch-marker ordering, cleanup failure, plaintext clearing and exact
  HTTP/Slack/email outcome persistence have independent regressions.
- The real Nest HTTP suite is split into authentication/CSRF, same-input replay,
  destination authorization and error-redaction cases. Replay fakes compare
  actor/workspace/key/hash identity; builder, viewer, owner and admin policies
  reach the composed guards; raw KMS/provider causes and credentials do not
  enter serialized problems.
- Verification: scoped strict ESLint passes for connection source, runtime and
  tests; `@pertexo/api` typecheck and build pass; the connection plus API
  bootstrap cohort passes 12 files / 180 tests. No commit, push, deployment, or
  live external operation was performed.

## Q14 evidence log

- Workspace database cancellation options now cross the Nest adapter unchanged.
  Worker configuration rejects timer overflow and insecure deployed KMS or
  artifact endpoints at their actual policy seams, freezes every nested runtime
  section, normalizes supported scalar inputs, and covers the exact heartbeat,
  resource, job-allowlist and partial-storage boundaries.
- Readiness owns one bounded cancellable check and revokes health immediately on
  shutdown without late resurrection. Resource monitoring contains logger and
  signal failures while preserving monotonic drain, and process-start metrics,
  supervisor delays, background deadlines and keepalive timers have exact
  lifecycle regressions including hostile and late settlements.
- Dispatcher close caches one outcome, owns concurrent direct and loop
  dispatches, wakes polling without a lost-close race, rechecks readiness after
  probes, and drains claim, publish, mark, release and observation work before
  dependencies. Ambiguous queue and database outcomes retain the original lease
  token through late success, stale, failed and rejected settlements; hostile
  adapter errors cannot replace durable release policy.
- Capacity observations receive the exact transaction signal, run serially,
  stop replacement work behind an abort-ignoring operation, and retain raw work
  ownership after a reported close deadline before closing database/queue
  dependencies. The 100-pending and 1,000-tracked limits are exercised through
  valid batches no larger than the configured limit.
- Dispatcher, preview-maintenance and application composition register owners as
  they are acquired, roll back every partial construction stage with ordered
  aggregate failures, and cache shutdown. One worker-level coordinator drains
  transport first, then attempts database resources and telemetry even when a
  sibling fails; custom runtimes/delivery capabilities acquire no hidden owners.
  Capability registration now follows the configured active-job order and has
  explicit empty, invalid, missing, shared-consumer and post-wait readiness
  contracts.
- Worker unit and lifecycle coverage configs share the queue alias and four-fork
  runner cap while retaining separate inventories and thresholds. Process
  fixtures install exit/error observation immediately, bound captured output,
  surface forced-reap failure and use an injected readiness marker instead of
  shared `/tmp` state.
- Verification: `@pertexo/worker` typecheck/build and 56 files / 601 tests pass;
  both worker coverage cohorts pass at 93.99% statements / 94.23% branches and
  82.92% statements / 70.22% branches; compiled main and application lifecycle
  tests pass 8 cases; `@pertexo/observability` passes 13 files / 109 tests; and
  scoped strict ESLint plus `git diff --check` pass. No commit, push, deployment,
  or live external operation was performed.

## Q15 evidence log

- Coordinator, trigger and preview-maintenance composition now register each
  acquired owner before the next acquisition, preserve primary and cleanup
  failures, cache close completion, bound raw consumer/scanner/recovery work and
  defer dependent-store disposal until late work settles. Required first scans
  are visible to readiness, repeated scan failure fails closed, and stopped
  runtimes cannot become ready again. Logger and telemetry callback failures are
  contained without terminating required loops.
- Disabled preview and notification capabilities construct no optional stores or
  empty recovery timer. Enabled routing covers every supported and unrelated job;
  partial acquisition, synchronous/asynchronous close failure, repeated close,
  late raw settlement and compiled active-consumer startup/shutdown all have
  ownership regressions.
- Failure-notification delivery validates composition bounds and distinguishes a
  cooperating timeout from ignored cancellation. Abort before/during claim,
  before/after provider settlement and during completion is bounded; detached
  claim/provider/completion work stays explicitly owned, late fulfillment or
  rejection is observed, and no stale terminal write follows an unresolved
  provider operation. Immutable identity/checksum forwarding, busy/terminal
  claims, malformed results and hostile persistence values are covered.
- Provider-specific Slack/email ambiguity policy remains separate. Email retry
  tests allocate and zero fresh credential bytes for every attempt, exercise the
  second provider call, and pin deterministic binding inputs. Malformed Resend
  bodies retain non-2xx HTTP status truth, while hostile destination, credential,
  provider, reconciliation, trigger and replay values preserve their intended
  mapping or original identity.
- Compatibility and coordinator tests cover exact supported core definition
  versions, retained execution-node equality, missing/current/unsupported release
  evidence, projection epoch disagreement, every handler phase and a real
  cursor-only consumed-observation transition with no emitted effects. Import
  boundaries use TypeScript AST analysis, and compatibility fixture acquisition
  and cleanup preserve production authority order and all failures.
- Verification: `@pertexo/worker` typecheck/build and 58 files / 739 tests pass;
  both coverage cohorts pass at 94.21% statements / 94.47% branches and 94.30%
  statements / 89.23% branches; the failure-notification handler independently
  reaches 100% statements/lines/functions and 97.43% branches; the Resend client
  regression suite passes 44 tests; and scoped strict ESLint plus
  `git diff --check` pass. No commit, push, deployment, or live external
  operation was performed.

## Q16 evidence log

- PostgreSQL telemetry contains hostile diagnostic callbacks, drains active
  samples, releases a shared monitor exactly once per owning pool, and preserves
  business, diagnostic and close failures. Database runtime shutdown is cached,
  rejects post-close acquisition, preserves borrowed ownership and carries
  cancellation through every workspace transaction boundary.
- Migration execution validates every published file against the ordered plan,
  bounds connection and lock acquisition, preserves cleanup failures, and makes
  the CLI import-safe. The qualified nontransactional mode proves the exact
  partial-success state: a concurrent index may commit before history recording
  is cancelled, and an unchanged rerun records it safely before continuing.
- Readiness now verifies exact PostgreSQL version, migration head, schema owner,
  effective table/column privileges, RLS policy expressions, trigger identity
  and enablement, constraint definitions, function ownership and safe
  configuration. Isolated drift fixtures exercise weakened and extra policy,
  trigger, constraint, function-path, ownership and inherited-privilege cases.
- Schema ownership accounts for all 68 migration tables as 49 typed and 19
  explicitly justified raw-SQL tables. Package-contract tests remain offline;
  the built validator checks all seven public database role surfaces, their
  declarations, and rejection of the package root and private source path.
- Disposable PostgreSQL fixtures validate destructive namespaces before SQL,
  compensate partial setup, aggregate teardown, and prove exact backend reuse,
  rollback hygiene, active-query cancellation, deterministic pool capacity and
  abandoned-transaction disposal. Migration-mode and published-repair fixtures
  are independently isolated and clean all temporary state.
- Verification: `@pertexo/database` passes typecheck and build, 95 files / 494
  unit tests, and the full 81-file / 453-test PostgreSQL integration suite. The
  schema validator passes 5 tests and verifies 68 tables; the built-export
  validator passes 7 tests and 24 consumer cases; broad database strict ESLint,
  scoped repository Prettier and `git diff --check` pass. No commit, push,
  deployment, or live external operation was performed.

## Q17 evidence log

- The rate-limit Redis owner caches shutdown before invoking effects, bounds a
  ready-client `QUIT`, always performs terminal disconnect, preserves the exact
  initiating `Error`, and never reconnects after close. Rejected, stalled,
  synchronous, repeated and reentrant close paths have unit regressions; a
  bounded local RESP fixture proves a stalled real ioredis socket disappears
  without reconnecting.
- Release admission rejects duplicate definition policy identities before set
  equality, including recomputed-fingerprint parse input, duplicate lists on
  both sides, unknown and version-drifted edges. Multiple definitions,
  executors and policies now prove top-level and nested permutation-independent
  fingerprints without changing retained golden release identities.
- Browser and server bounded-JSON admission share one private iterative
  traversal that creates, measures and returns the same deeply frozen own-data
  snapshot. Hidden root/nested `toJSON` getters and methods, post-descriptor
  mutation, object and array proxy reads, hostile thrown proxies/primitives,
  revoked proxies, UTF-8 byte edges, depth, members, null prototypes, repeated
  references, sparse arrays and hostile property names have parity regressions.
- Registry construction now separates release parsing from a cohesive
  registration-pinning and cross-coverage phase. Release-parser failures are
  normalized without trusting hostile thrown values, while ABI-2 success,
  missing runtime/marker, duplicate, concurrent, rejected and in-flight marker
  states have independent tests with fully drained deferred work.
- Catalog projection validates and clones its serving release once, then uses a
  private immutable registration index for trusted manifest projection. An
  instrumented module-boundary test proves one whole-release validation per
  multi-definition catalog; every cohort has deterministic ordered, deeply
  frozen, byte-equivalent browser metadata with no executor, ABI or policy leak.
- Catalog history keeps its independent golden fingerprints and epoch table.
  A labeled lifecycle matrix proves every additive identity is absent from its
  predecessor and nondispatchable while staged. Provider composition tests now
  live with server registry ownership, assert Slack/email call counts and
  secret zeroing, and Merge/Parallel smoke cases live in the cohort-execution
  suite with names matching their assertions.
- Verification: rate-limit passes 4 files / 37 tests at 95.00% statements and
  91.02% branches; node-sdk passes 2 files / 51 tests at 91.26% statements and
  83.10% branches; node-catalog passes 8 files / 77 tests at 96.15% statements,
  84.48% branches and 100% functions. All three pass typecheck, build and scoped
  strict ESLint. Workflow-model passes 9 files / 97 tests; focused API catalog
  and rate-limit unit cohorts pass 7 files / 83 tests; the authenticated local
  Redis cohort passes 2 files / 14 tests. Workspace import-cycle/reference
  checks, 24 built consumer cases, scoped Prettier and `git diff --check` pass.
  No commit, push, deployment, or live external operation was performed.

## Q18 evidence log

- For Each validation now performs the shared iterative bounded-JSON admission
  before recursive Zod parsing and pipes the admitted owned snapshot into its
  unchanged structural contract. Cycles and excessive depth fail without a
  stack overflow; exact/over depth, member, byte and 1,000-item boundaries,
  output cardinality, unchanged caller input and retained manifest history are
  pinned.
- Validate names its bounded code-point counter and skips it when no length
  rule exists. Zero/exact/over bounds, minimum-only and combined constraints,
  astral symbols, combining marks, lone surrogates and long unconstrained text
  retain minimum-before-maximum semantics and code-point—not grapheme—units.
- Browser and server graph draft entrypoints now share one browser-safe,
  descriptor-only admission module that returns an immutable own-data snapshot.
  It uses explicit enter/exit frames, rejects oversized arrays from their
  minimum byte footprint before enumeration, aligns config/literal depth and
  reserved-key policy, preserves distinct browser/server non-finite diagnostics,
  and feeds aggregate plus structural parsing only the admitted snapshot.
  Cyclic/shared references, exact UTF-8 bytes, nested totals, getters, throwing
  reads, hostile thrown and revoked proxies, and secondary-trap containment are
  covered without changing retained checksums, ETags or generated contracts.
- Evaluator shutdown caches one promise, selects cancellation for active work,
  retains workers through termination settlement, deduplicates finish/shutdown/
  abort hard stops, releases capacity only after cleanup, preserves selected
  evaluation results when cleanup rejects, and reports one or aggregated
  shutdown failure. Protocol tests cover duplicate readiness/start, result
  before start, synchronous construction/handoff failure, late results, queued
  shutdown, capacity and restart behavior.
- PF-07 selected and implements the package-owned no-accessor context contract.
  Own data descriptors feed canonicalization; all hostile failures become the
  constant fresh error. Top-level/nested getters execute zero times and create
  zero workers, while null-prototype and ordinary JSON contexts retain values.
  Numeric JSON paths now require own array indices, with dense, missing,
  inherited and present-null behavior pinned; cross-body mapping validation
  asserts both exact offending paths and issue count.
- Verification: workflow-model passes typecheck/build, 9 files / 112 tests and
  coverage at 89.61% statements / 83.77% branches / 95.31% functions;
  nodes-core passes typecheck/build, 7 files / 109 tests and coverage at 97.79%
  statements / 94.52% branches / 100% functions. Node SDK passes 51 tests,
  catalog 77, contracts 50 plus generated-artifact validation, focused API 13
  and worker owner cohorts 57. Scoped strict ESLint, workspace architecture,
  all 24 built consumers, retained catalog history, browser projections and
  `git diff --check` pass. Q18 adds no reported complexity hotspot, duplicate,
  or unused dependency/export; repository-wide complexity, duplication,
  dependency and formatting gates remain red on non-Q18 worktree findings. No
  commit, push, deployment, or live external operation was performed.

## Q19 evidence log

- Producer readiness now rechecks the complete lifecycle after BullMQ readiness,
  so a Redis close/error or a fully completed concurrent close cannot be
  overwritten by a late ready result. Independent per-client Redis listener
  state proves one producer's connection event cannot affect another.
- Redis failure classification contains every unknown-value inspection,
  including hostile prototype, name and message access. Operation and command
  wrappers preserve the exact original promise and rejection while emitting
  only fixed telemetry labels; recorded attribute arguments are checked
  directly for the allowed bounded values and absence of sensitive sentinels.
- Producer close starts every queue and Redis fallback independently, protects
  synchronous invocation and immediately observes asynchronous rejection. A
  rejecting, throwing and never-settling fallback matrix preserves the exact
  authoritative close failure for concurrent callers without leaving an
  unhandled rejection.
- Shared consumer mocks restore close behavior per test; timeout, drain and
  late-publication cases use deterministic timers with guaranteed restoration.
  A timed-out handler's late settlement cannot create a second finish event or
  prevent the next delivery. The supported-job table now covers replay and is
  proven exactly complete against the advertised job-name registry.
- Verification: `@pertexo/queue` passes typecheck/build, 11 files / 76 tests in
  ordinary and shuffled order, and coverage at 87.55% statements / 78.70%
  branches / 87.85% functions / 87.70% lines. Scoped strict ESLint, Prettier
  and `git diff --check` pass. No commit, push, deployment, or live external
  operation was performed.

## Q20 evidence log

- Artifact request settlement attaches handlers to every already-started
  promise before observing cancellation, centralizes one terminal settlement
  and listener removal, and normalizes hostile foreign values without
  inspecting them outside a guard. Pre-abort plus late resolve/reject, abort
  during both presigner invocations, post-registration races, hostile/revoked
  failures and cancellation reasons all pass; a bounded child-process proof
  reports zero unhandled rejections.
- Object-store command and error classification is total across constructor,
  name, metadata, prototype and abort-reason traps. S3, presign, artifact-store
  and control-ledger wrappers retain exact business results and failures while
  emitting at most one fixed, bounded observation. Provider not-found,
  precondition and transfer-abort classification is likewise guarded.
- One package-internal append-material seam owns normalization and exact replay
  comparison. Both-region replay, either one-sided repair, every trimmed field,
  invalid union material, identical frozen dispatch and two real in-memory
  regional adapters prove normalized persisted material is authoritative.
- Single-region PUT now compares every verified metadata field with the admitted
  request. Individually valid changed hash, media type and byte length fail
  closed without deletion; missing, malformed, matching, post-upload abort and
  ambiguous-write behavior remains intact.
- WQ-027's ownership evidence reproduced receiver rejection before stream
  consumption, so the coordinator now closes every primary download it acquires
  while preserving replication/integrity outcome policy. The public contract
  records that caller stream ownership transfers only after request preflight;
  closed-store rejection leaves the caller's stream untouched.
- Test ownership now uses named readiness coverage, stage-latched anchor/batch/
  continuation cancellation, a real duplicate-acknowledgement path, explicit
  unsupported fake commands and independently named validation cases. Provider
  integration requires an explicit dedicated-fixture marker and known selector,
  registers all four clients for teardown before setup, and bounds and disposes
  fetch responses. Its 9 external tests were skipped because no authorized
  dedicated provider fixture was supplied.
- Verification: `@pertexo/artifact-store` passes typecheck/build, 10 files / 333
  tests in ordinary and shuffled order, and coverage at 97.48% statements /
  95.97% branches / 97.14% functions / 97.61% lines. Scoped strict ESLint and
  Prettier, workspace architecture, all 24 built consumers, 9 API artifact,
  55 worker capability, 17 lifecycle-command, 13 recovery and 57 retention
  owner tests, and `git diff --check` pass. Complexity, duplication and unused-
  export scans report no Q20 finding; their repository-wide commands remain red
  only on other worktree packages. No commit, push, deployment, or live external
  operation was performed.

## Q21 evidence log

- Resend refusal parsing now retains every non-2xx status across empty, invalid
  UTF-8, malformed JSON, and unknown JSON bodies. Credential resolution applies
  an explicit current-versus-historical outcome matrix, so invalid, throttled,
  cancelled, transient, unknown, and provider outcomes neither dispatch nor
  collapse prior uncertainty incorrectly. Malformed successful replays still
  preserve idempotency-key reuse.
- One guarded unknown-error inspection seam snapshots hostile `name`, `code`,
  numeric status, and abort-reason values at most once. Secure HTTP, request,
  stream, dispatch-fence, email, and Slack paths use that total classifier.
  Cancellation races attach observers to already-started operations before
  returning; primitive, throwing-proxy, revoked-proxy, iterator, cleanup, and
  late-rejection matrices plus an isolated child process prove no unhandled
  rejection or unsettled work.
- Literal-address detection is pure while public resolution supplies dispatch
  context. Initial private literals fail before dispatch; a redirect from one
  public dispatch to a private literal retains `requestDispatched: true`.
  Transport response ownership closes late fulfilled responses exactly once,
  observes late rejection, preserves normal response ownership, and a local
  native HTTP fixture proves cancellation destroys the socket.
- Envelope decoding rejects encoded oversize material before allocation and
  decodes every component before KMS I/O. Decoded envelope bytes, provider key
  bytes, cipher/decipher temporaries and connection/webhook key references are
  cleared across success, authentication failure, cancellation, and factory
  failure. Exact-limit and one-byte-overflow cases prove the preflight, while
  UTF-8 key-reference validation occurs before provider client construction.
- HTTP, Resend, Slack and secure-request outcome tests use independent ADR-based
  oracles over every public code/state combination. Slack shares only response
  envelope parsing; auth and send retain different required-success fields.
  URL refinement is total for malformed, relative, empty, hostile and ordinary
  values. A real transitive browser-entry graph covers the integrations root and
  email, HTTP and Slack subpaths.
- Verification: `@pertexo/integrations` passes typecheck/build, scoped strict
  ESLint and Prettier, 13 files / 385 tests in ordinary and shuffled order, and
  coverage at 96.90% statements / 94.65% branches / 98.63% functions / 97.27%
  lines. The complete worker suite passes 58 files / 739 tests and the complete
  API suite passes 83 files / 840 tests; both typecheck and build. Workspace
  architecture and all 24 built-package consumers pass, as does
  `git diff --check`. Complexity, duplication and unused-export scans report no
  Q21-owned finding; their repository-wide commands remain red only on other
  planned work packages. No commit, push, deployment, live provider request, or
  other external operation was performed.

## Q22 evidence log

- Connection-test URL admission now counts one-, two-, three-, and four-byte
  Unicode code points, including unpaired-surrogate replacement behavior, while
  leaving the existing ASCII/Latin-1 header policy intact. Exact 2,048-byte and
  one-byte-overflow cases pass for every relevant width. The API caller rejects
  an over-byte supplementary-character URL after authorization but before test
  reservation, secret resolution/decryption, or provider-client invocation.
- Node-test arbitrary inputs pass through a browser-safe iterative preflight
  before recursive Zod JSON parsing. It enforces the server canonicalizer's
  depth-256 contract, rejects cycles, accessors, sparse/extended arrays,
  non-finite and non-JSON values, exotic prototypes, symbols, hostile proxies
  and revoked proxies without leaking traps, and stops at the first excess-depth
  branch. Exact depth and 10,000-level serialized array/object regressions cover
  both validation samples and manual execution input. A fully authenticated,
  CSRF-valid HTTP request returns `request.invalid` at 400 before draft lookup or
  preview reservation.
- The projected node-test schemas retain a real recursive JSON contract in
  nested `$defs` and publish the runtime depth marker rather than degrading the
  field to unconstrained `{}`. Projection tests cover nested definition owners,
  root self-references, escaped JSON Pointer segments, and all generated local
  references. The browser depth constant has a parity test against the
  server-only canonical JSON owner.
- Webhook management responses are a structural union on `replayed`: replay
  branches structurally forbid credential values, non-replay branches preserve
  every supported optional credential combination, explicit `undefined`
  remains compatible for direct runtime callers, and unknown keys remain
  rejected. An independent Ajv 2020-12 matrix executes the committed OpenAPI
  component alongside the runtime schema. API service owner tests pass replay
  redaction behavior; the separately gated direct-database assertion was
  inspected and left unchanged.
- The former cross-domain contract test was split into focused connection,
  node-testing, identity, transport, schema-projection, authoring, and run
  suites. Aggregate credential bytes now use individually valid headers at the
  exact aggregate edge; mixed destination kind and invalid optimistic version
  fail independently with positive controls. Content-Type tests distinguish
  the authoritative OpenAPI request-body media type from the supplemental
  header parameter and runtime charset restriction. Every public subpath now
  has a real transitive workspace-import browser check.
- Verification: `@pertexo/contracts` passes 16 files / 70 tests in ordinary and
  shuffled order, typecheck/build, scoped strict ESLint and Prettier, and
  coverage at 98.88% statements / 95.93% branches / 100% functions / 99.76%
  lines. All 18 deterministic artifacts match and all nine OpenAPI documents
  lint. The full API suite passes 83 files / 843 tests plus typecheck/build;
  workspace architecture and all 24 built-package consumers pass, as does
  `git diff --check`. Complexity, duplication, and unused-export scans report no
  Q22-owned finding; their repository-wide commands remain red only on other
  planned work packages. No commit, push, deployment, live provider request, or
  other external operation was performed.

## Q23 evidence log

- Artifact finalization now explicitly preserves the established typed
  `AuthorizationError` across the database callback boundary after external
  object verification. Unit regressions cover active-to-missing, removed
  membership, suspended workspace, lost upload capability and mismatched
  workspace access. Each case observes two authorization lookups, one object
  verification and a false commit marker, while genuine store outages remain
  `artifact.unavailable` and integrity/missing-object failures remain lifecycle
  conflicts.
- Artifact service tests independently cover pending, available, deleting,
  deleted and missing decisions; exact 59/60/900-second signing boundaries;
  expired finalize; quota, idempotency, conflict, not-found and outage mapping;
  pending-download denial; and the exact public metadata projection without
  storage key or purpose. Controller tests now use valid contract-shaped
  fixtures and cover finalize, metadata and download route/signal forwarding.
  Runtime tests close real shared and API runtimes on assertion failure and
  prove both-close aggregation plus cached repeated rejection.
- The transfer fixture owns every resource from first acquisition, transfers
  nested ownership explicitly to identity/artifact runtimes and then the Nest
  application, closes application-owned resources before remaining pools and
  stores, protects synchronous close calls, aggregates failures and caches its
  close result. Setup cleanup preserves the original error plus every cleanup
  error. Tests cover partial identity/store/application acquisition, transferred
  owners, reverse order, a held cleanup barrier, and multiple close failures.
  Log capture is fixture-owned; fresh applications share it explicitly.
- The gated transfer suite has individually named authentication, CSRF, input,
  role, tenant, workspace-state, immutable-header, object-integrity and quota
  cases. Capacity/state restoration is failure-safe, external fetches are
  bounded, response bodies are consumed or cancelled, and received artifact
  JSON is parsed through the shared contract schemas. A real PostgreSQL plus
  dual-region S3Mock race removes membership after replica verification and
  returns `auth.forbidden` at 403 while the artifact remains pending and its
  capacity charge is unchanged. The suite continues to state S3Mock's signed
  header limitation rather than treating it as provider qualification.
- Catalog ordering uses one ordinal comparator with named provider/key
  tie-breaks and numeric version order. A shuffled catalog regression proves
  provider/operation grouping, versions 2-before-10, non-integration exclusion,
  independent per-version flags and immutable repeated responses. The actual
  Nest testing module resolves the controller and both use cases with the real
  catalog module wiring.
- Verification: the API passes 84 files / 883 tests in ordinary and shuffled
  seed-23063 order, typecheck/build, scoped strict ESLint and Prettier. Its four
  configured coverage cohorts pass; the primary cohort is 100% statements,
  branches, functions and lines. The gated transfer suite passes 22 real
  PostgreSQL/S3Mock cases. Workspace architecture (15 tests) and all 24 built
  package consumers pass, as does `git diff --check`. Complexity, duplication
  and unused-export scans report no Q23-owned finding; their repository-wide
  commands remain red only on other planned work packages. No commit, push,
  deployment, live provider request or other external operation was performed.

## Q24 evidence log

- Authorization proof evidence now records the observed workspace lifecycle
  status. Reuse checks abort first and require actor, request, trace,
  capability, route and requested status-policy compatibility without a second
  lookup. Broader-to-active reuse rejects, matching suspended reuse and active
  reuse under a broader policy remain lookup-free, and abort preserves the
  exact reason.
- The shared OAuth callback wire contract deliberately strips unknown provider
  extensions while projecting only bounded `code` and `state`; repeated,
  missing, malformed and oversized known fields reject before login. Generated
  client and OpenAPI artifacts agree with runtime behavior without weakening
  strict workspace-write objects.
- OIDC endpoint policy has one explicit five-field owner for protocol,
  credential and fragment validation. PKCE challenge validation expresses the
  exact 43–128-character set once. Transaction consumption is a discriminated
  application union, database results are explicitly adapted, malformed
  success is contained, all denial outcomes avoid provider exchange, and a
  valid first login supplies an honest replay proof.
- Secret-encryption configuration validates shapes, versions and duplicates
  before key decoding, preserves the defensive single previous-key input, and
  clears already allocated keys after a later parse failure. Encoded input is
  bounded before decoding. Owned seal plaintext and authenticated or partial
  open plaintext buffers are cleared on success and tag failure while the wire
  format, associated data and stable error vocabulary remain unchanged.
- The unused API audit sanitizer and its test-only consumer were removed after
  production-consumer inspection. Durable database audit writers and ADR-004
  obligations remain authoritative. Authentication/cookie controllers and
  tests are separated from workspace routes; database mappings, session
  cleanup, profile availability, exact cursors, lifecycle responses, error
  classes and callback extension behavior now have independently named cases.
- Identity telemetry lazily owns one authoritative business promise across
  callback omission, duplication, synchronous trace throws and asynchronous
  trace rejection. The identity runtime is awaited, cleans partial acquisition,
  defers every closer, attempts both owners after synchronous failure and
  caches shutdown. Reader locks and abort listeners are released after OIDC
  response reads, and transport-only cases share immutable key material.
- The gated real-API fixture acquires resources only inside its awaited setup,
  tracks every owner from creation, preserves setup failure through aggregate
  cleanup, closes the application before identity/database owners and avoids
  double-closing injected aliases. Disabled collection acquires nothing.
  Workspace lifecycle/member stories seed their own workspaces, workflow
  authoring and run behavior are independent named stories, and SSE next/return
  are bounded with unconditional abort/release. Session TTL no longer competes
  with the long workflow story; expiry remains deliberate controlled-clock
  evidence. The disposable PostgreSQL/Redis lane was not enabled, so no
  service-backed success is claimed.
- Verification: the 18 identity/workspace unit files pass 254 tests in ordinary
  and seed-24074 shuffled order; the full API passes 84 files / 953 tests with
  one environment-gated case skipped. API typecheck/build, scoped strict
  ESLint, all four configured coverage cohorts (primary 100% statements,
  branches, functions and lines), 16 files / 70 contract tests, deterministic
  artifact checks, all nine OpenAPI lints, 15 architecture tests and all 24
  built-package consumers pass. `git diff --check` passes. Repository formatting
  and complexity remain red only on files owned by earlier unfinished planned
  packages, with no Q24-owned finding. No commit, push, deployment, provider
  request, disposable-service execution or other live external operation was
  performed.

## Q25 evidence log

- Webhook acceptance now owns one lazy authoritative business promise while
  treating tracing as diagnostic-only. Synchronous and rejected tracer failure
  before or after callback, duplicate callback, traceparent getter failure,
  counter/status/end failure, invalid and all-zero remote parents, and
  concurrent business/diagnostic failure preserve the exact business result
  and invoke durable acceptance at most once. Parser-level unsupported media
  type uses the webhook vocabulary, and current/previous secret buffers are
  cleared across decrypt and signature failures.
- Schedule and webhook runtime factories are awaited ownership boundaries.
  Partial construction cleans every acquired owner, synchronous and rejected
  close failures are deferred and cached, webhook shutdown attempts envelope
  and database cleanup independently, and injected/shared database leases keep
  their established ownership. Public-factory regressions cover acquisition,
  forwarding, repeated close and aggregate failure.
- Webhook provision, endpoint rotation and secret rotation have explicit
  operation bodies. Secret rotation requires and validates its endpoint key
  before random material or sealing; generated buffers acquire cleanup
  ownership immediately. Stable hashes, pre-persistence abort, post-command
  ownership proof and replay non-disclosure remain intact. Schedule and webhook
  health responses project typed public fields explicitly, omitting injected
  storage-only fields while preserving nullable ISO dates.
- Controller, module, telemetry and service suites exercise exact route and
  actor forwarding, idempotency validation, guard/CSRF composition, denial
  before mutation, list filtering, every credential disclosure combination,
  exact hash identity, replay, known/unknown errors and diagnostic containment.
  A committed-response serialization failure proves one acceptance followed by
  successful replay rather than an invented rollback.
- The direct-webhook fixture allocates only in awaited setup, records each
  acquired owner immediately, preserves runner-owned database mode, quotes role
  and database identifiers, closes application before dependencies, attempts
  all independent releases and aggregates setup/cleanup failures. Its bounded
  HTTP client preserves exact signed bytes while bounding request time and
  response size and containing malformed UTF-8/JSON, truncation, abort, close
  and socket errors. The omnibus story is split into independently seeded
  atomicity/replay, malformed body, rotation, quota, disclosure, verification
  outage and endpoint-replay cases; captured request material and reference-only
  queue payload assertions replace regenerated-signature and substring proxies.
- Verification: 13 focused schedule/webhook/support files pass 135 tests. The
  API passes typecheck/build and 93 files / 1,056 tests with one unrelated gated
  skip in ordinary and seed-25025 shuffled order. All four configured API
  coverage cohorts pass (primary 100% statements, branches, functions and
  lines); the entrypoint cohort passes after an explicit telemetry-cleanup
  failure regression. Contracts pass 16 files / 70 tests, deterministic
  generation and all nine OpenAPI lints. Scoped strict ESLint, Prettier,
  15 architecture tests, all 24 built-package consumers and `git diff --check`
  pass. Repository complexity and duplication remain red only on earlier
  unfinished planned-package changes, with no Q25-owned finding. The explicitly
  gated disposable PostgreSQL/KMS webhook lane was not executed, so no deployed
  KMS or real timeout qualification is claimed. No commit, push, deployment,
  provider request or other live external operation was performed.

## Q26 evidence log

- Selected-node preparation now rejects configuration versions that do not
  match the pinned definition manifest. Validation returns the exact bounded
  `node.config_version_incompatible` issue, while execution stops before
  durable acceptance or provider invocation. Existing worker-side persisted
  identity checks remain the independent defensive boundary.
- Authenticated execution computes its existing actor-scoped idempotency and
  request hashes before reading mutable draft state. A narrow database replay
  resolver checks active builder authority, detects changed-request conflicts,
  and projects only retained preview acceptance/disclosure facts. Exact retries
  therefore survive draft revision, node and configuration changes without a
  second attempt or outbox event; new keys still undergo current draft
  admission, and the atomic acceptance transaction remains race authority.
- Validation tests independently cover absent and duplicate nested nodes,
  unknown definitions, old/future configuration versions, connection shape,
  mapping and input failures, deferred prior-preview input, deterministic
  100-issue truncation and public field bounds. Execute tests pin exact ETag,
  release identity, five-minute deadline, seven-day retention, request/key and
  provider-key hashes, trace forwarding, idempotent email behavior, replay
  after draft mutation, changed-content conflict and unknown failures.
- The preview status use case has named authorization, absence, null/inline/
  artifact output, date/error and frozen-context cases. Controller and composed
  Nest/Fastify tests cover strict single idempotency values, validation's
  intentional indifference to that header, traceparent forwarding, real
  200/202 behavior and registered evaluator execution. Error rows cover every
  owned mapping class, with an exact RFC 9457 global-filter serialization proof
  that drops private issue fields.
- The disposable PostgreSQL preview lane passes 10 cases, including retained
  replay after draft mutation, changed-content conflict, simultaneous
  first-request deduplication, cross-workspace concealment and suspended-member
  denial. Focused worker preview invocation passes 26 tests. The database unit
  suite passes 95 files / 494 tests; the API passes 93 files / 1,099 tests with
  one unrelated gated skip in ordinary and seed-26026 shuffled order. All API
  coverage cohorts pass (primary 100% statements, branches, functions and
  lines), as does the entrypoint cohort.
- Database, API and worker typecheck/build, scoped strict ESLint and Prettier,
  15 architecture tests, all 24 built-package consumers and `git diff --check`
  pass. The read-only replay phase was separated from atomic acceptance so Q26
  introduces no complexity hotspot or unexplained clone. Repository complexity
  and duplication remain red only on other unfinished planned packages. No
  commit, push, deployment, provider request or other live external operation
  was performed.

## Q27 evidence log

- ADR-011 now makes the transaction-selected compatibility catalog part of
  save authority. The API still performs its early full-tag check, but forwards
  the original opaque tag into the database transaction; the locked current
  draft and selected catalog must reproduce that tag in addition to passing the
  existing revision CAS. A deterministic disposable-database rollout proves an
  activation-only representation change rejects the old tag without advancing
  the draft. Unchanged-tag success, malformed and wrong tags, a real revision
  change, invisible workflow behavior and exact single-snapshot conflict
  metadata have direct database coverage. Tag calculation no longer constructs
  and validates a discarded HTTP response.
- Workflow-authoring telemetry owns one lazy business promise across tracer
  callback omission, repetition, synchronous throw and asynchronous rejection.
  The original business result or rejection stays authoritative; every acquired
  span ends once, diagnostic failures are contained, and duration/outcome
  metrics record once. Its reviewed feature-local duplication entry now matches
  the smaller current fragment and cardinality rationale.
- Controller routes project authenticated context once while keeping route,
  precondition, ETag and trace responsibilities visible. Error mapping imports
  cursor ownership directly and preserves typed application errors before
  structural fallback. Redundant ETag and authorization types are removed and
  module telemetry is selected once. Tests use contract-valid fixtures and pin
  exact delegation, actor context, precondition codes and length edges, error
  vocabulary/safe details, publish hashes, compatibility rejection, explicit
  workflow/version projections, retained graphs, cursor variants and exact ETag
  sensitivity.
- The lifecycle fixture tracks resources from first acquisition, explicitly
  transfers identity dependencies, closes the application before remaining
  owners, attempts reverse-order cleanup, preserves setup plus cleanup failures
  and caches teardown. Failure injection covers every owner in the lifecycle
  graph. Requested integration now requires explicit API, migration and Redis
  configuration; it has no service fallback. OIDC login remains deliberately
  sequential and its cookie parser has scalar, array, missing, encoded and
  name-selection coverage without reflecting session values.
- Lifecycle HTTP tests use a fresh scenario per named authentication, header,
  authority, workspace-state, idempotency, CAS and history case. Exact response
  keys and all public fields are asserted. Version restoration proves owner and
  builder success, identical-content fresh tags, stale retry, archived-target
  denial, same-workflow, unknown and existing cross-tenant source concealment,
  and unchanged retained version/run/lifecycle history.
- Verification: 10 focused authoring/support files pass 137 tests with one
  deliberately disabled nested fixture case in ordinary and seed-27084 shuffled
  order. The full API passes 94 files / 1,166 tests with the same one skip in both
  orders. All configured API coverage cohorts pass; the primary cohort remains
  100% statements, branches, functions and lines, and the entrypoint cohort
  passes. The explicitly configured local PostgreSQL/Redis lifecycle and version
  files pass 12 cases; the disposable compatibility-rollout file passes; and
  five database authoring files pass 23 cases. API/database build and typecheck,
  worker typecheck, scoped strict ESLint and Prettier, 15 architecture tests, all
  24 built-package consumers and `git diff --check` pass. Repository-wide
  complexity, duplication and formatting remain red only on files owned by
  earlier unfinished packages, with no unresolved Q27-owned finding. No commit,
  push, deployment, provider request or other external operation was performed.

## Q28 evidence log

- Iterator failure handling preserves arbitrary adapter rejection identity
  without coercion or prototype inspection, removes abort observers on every
  settlement path and observes late resolution/rejection after cancellation.
  Stream subscription and iterator acquisition now enter cleanup ownership
  before fallible work; synchronous factories, first reads, concurrent primary
  and cleanup failures, and nonsettling siblings all attempt every releaser.
- Authorization lifetime separates a fixed session-expiry ceiling from its next
  idle refresh. Fixed expiries above five seconds, at one second, below one
  second and exactly expired remain bounded; only a verified later expiry
  schedules another refresh. Per-frame authorization, revocation, concurrent
  refresh coalescing and cancellation of stalled lookups remain intact.
- SSE cleanup starts all siblings concurrently, applies the shared five-second
  budget, retains observation of late settlements and keeps drain registration
  until concrete cleanup completes. The writer moved to a focused private
  transport module; response routes remain route/guard orchestration. Delivery
  survives throwing visibility metrics, while backpressure, disconnect,
  destination failure and producer/cleanup aggregation have direct tests.
- Durable reconstruction validates a complete page before emitting it, rejects
  over-limit, gapped, duplicate, out-of-order, malformed and oversized rows,
  reads once beyond an exact page boundary and suppresses pages resolving after
  abort. Redis source tests cover initial subscribe and readiness timeout,
  rejection, abort and late settlement; wrong-channel/oversize hints; rejected
  then successful resubscribe; repeated close and exact listener disposal.
  PostgreSQL reader tests pin workspace, run, cursor, limit and signal bindings,
  ordinary failure identity and post-resolution cancellation.
- Start and replay request hashes are canonical across reordered input keys and
  exclude request/trace metadata, while actor, workspace, workflow/source,
  version, input, deadline and absent-versus-null distinctions remain explicit.
  Persistence maps every owned known error and preserves unknown failures,
  publishes no wake-up for replayed acceptance or unchanged cancellation, and
  never converts a committed command into failure when Redis publication fails.
- Initial checkpoint tests compile real root, Condition, Switch, For Each and
  Parallel V1/V2/V3 executables and assert engine/workflow identity, sequence
  and the 1,000-iteration budget. Unsupported release, checksum and epoch
  mismatches fail closed. A composed Nest/Fastify test proves authentication and
  workspace guards run before use cases and exact RFC 9457 status/code mapping
  for not-found, non-executable, idempotency and non-cancelable failures.
- Streaming and compatibility fixtures register all acquired owners
  incrementally, preserve setup/assertion plus cleanup failures and use
  configurable safely quoted roles. The Redis-loss lane additionally requires
  three explicit disposable-target gates, a scoped Compose project, loopback
  URL/port agreement and an observed Compose port before service control;
  restoration, abort and iterator release are independent cleanup attempts.
- Verification: 13 focused execution/workflow-run files pass 170 tests. The
  full API passes 97 files / 1,273 tests with one intentionally gated skip in
  ordinary and seed-28089 shuffled order. All four configured API coverage
  cohorts pass; the primary cohort remains 100% statements, branches, functions
  and lines. API typecheck/build, scoped strict ESLint and Prettier, 15
  architecture tests, all 24 built-package consumers and `git diff --check`
  pass. The ordinary SSE, destructive Redis-loss and compatibility-rollout
  integration files collect cleanly and remain explicitly environment-gated;
  they were not enabled, so no disposable-service success is claimed. No
  commit, push, deployment, provider request or other live external operation
  was performed.

### Q01/Q28 nested-read follow-up — 2026-09-14

- A real composed `createWorkflowRunEventStreamer` → `StreamRunEventsUseCase` →
  SSE writer regression exposed one remaining nested-cleanup failure. When a
  page read rejected, the inner unbounded generator entered `finally` and
  awaited a held live iterator `return()`; the HTTP writer consequently did not
  settle after the configured 25 ms cleanup budget.
- Producer failure now aborts with a tagged opaque reason before cleanup. The
  transport recovers the exact original rejection without inspecting or
  coercing it, retains the abandoned frame pull, and begins abort observation,
  pending-pull observation, iterator release and response termination
  concurrently. A cleanup that exceeds the shared deadline reports the honest
  `StreamCleanupIncompleteError`, while the retained drain observes the real
  eventual completion. Focused tests also pin late success and rejection,
  listener removal, and timer disposal.
- The real nested regression passes both cases, and that source state's full API run
  passes 97 files / 1,275 tests. The complete 24-cohort coverage producer passes
  at source fingerprint
  `sha256:de01d5bd8e0d3cfd776624f69bb6bb4b7bbd7245f72750d4825f4b3f4cc6c07a`.
  Its reconciled risk evidence records 405 reviewed and zero unreviewed
  branches across 186 selected files and 7,500 coverable lines. The source
  inventory accounts for all 691 files as 287 measured runtime, 28 measured
  declaration, 322 source-mapped owner-suite, zero unmapped runtime and 54
  build/type/export-contract files.
- Full `pnpm quality:local` run
  `pertexo-local-quality-2026-09-14t00-24-11-551z-71158-2b99557e` passed all 21
  cohorts with stable start/end source identity and owned cleanup. Its service
  evidence contains 6 locally executable artifact-store tests, 1 queue test,
  525 database tests, 44 worker integration tests, 64 API integration tests, 21
  worker recovery tests, and one test in each SSE resilience, worker transport
  resilience, API compatibility and database compatibility cohort. The only
  exclusions are the three declared AWS-only controls: dual-service Object
  Lock, primary conditional create and recovery conditional create.
- This is local qualification only. No hosted CI run, branch-protection
  operation, AWS-only external check, deployment, push, provider request or
  other live external operation was performed.

### Q01/Q28 public-projection follow-up — 2026-09-14

- Public validation and projection originally executed directly inside a
  `for await` body. A projection failure therefore initiated JavaScript's
  implicit close of the lower generator before the error could reach its own
  producer-failure catch. A stalled subscription iterator `return()` held that
  implicit close indefinitely, so the transport received no abort notification
  and could not start its shutdown budget.
- Public-frame projection now runs in a small synchronous boundary. If JSON,
  persisted-envelope, payload or public-event validation fails, that boundary
  reports the exact error through the existing producer-failure observer before
  rethrowing it. Observer failure cannot replace the authoritative projection
  error. The existing tagged abort reason, transport recovery, cancellation,
  abandoned-pull ownership, concurrent cleanup and late-settlement observation
  remain unchanged.
- The real streamer → authorization use case → SSE writer regression uses the
  existing invalid `schemaVersion: 2` payload and a held subscription iterator
  `return()`. Both late fulfillment and rejection settle the transport at its
  25 ms budget, preserve the original `ZodError`, close the subscription,
  iterator, response and drain registration exactly once, and leave no abort,
  destination or timer observers behind. The four-case nested matrix passed 30
  consecutive isolated runs; the final focused SSE/use-case set passes 5 files
  / 97 tests, and the full API passes 97 files / 1,277 tests.
- The complete 24-cohort coverage producer passes at source fingerprint
  `sha256:b460ce440131ff15831907d051f0b062f7f1e943ad538925a4c2bd6872c7d01c`.
  Risk evidence remains 405 reviewed and zero unreviewed branches across 186
  selected files and 7,500 coverable lines. The 691-file source inventory is
  unchanged: 287 measured runtime, 28 measured declaration, 322 source-mapped
  owner-suite, zero unmapped runtime and 54 build/type/export-contract files.
- Full `pnpm quality:local` run
  `pertexo-local-quality-2026-09-14t09-35-41-831z-24290-031bb08c` passed all 21
  cohorts with stable start/end source identity and owned cleanup. Its service
  evidence contains 6 locally executable artifact-store tests, 1 queue test,
  525 database tests, 44 worker integration tests, 64 API integration tests, 21
  worker recovery tests, and one test in each SSE resilience, worker transport
  resilience, API compatibility and database compatibility cohort. The SSE
  resilience lane observed failure in 1.10 ms, Redis backfill recovery in
  5,892.72 ms, health recovery in 5,869.75 ms and stop in 274.74 ms. The only
  exclusions remain the three declared AWS-only controls.
- This is local qualification only. No hosted CI run, branch-protection
  operation, AWS-only external check, deployment, push, provider request or
  other live external operation was performed.

## Q29 evidence log

- Session lookup uses the shared cancellation-aware transaction owner. Invalid
  or pre-aborted requests acquire no client, while a controlled PostgreSQL lock
  proves mid-query abort cancels the query, discards the uncertain client and
  permits a replacement backend. Session and OIDC expiries must be finite and
  future before SQL or sealing. User fields share one bounded validator, and
  identity metadata is iteratively bounded by bytes, depth and member count,
  copied into immutable ordinary data, and revalidated independently when read.
- OIDC consumption returns a discriminated transaction result while injected
  API seams remain runtime-validated. The nonce is durably consumed before
  either seal opens; controlled first- and second-open failures, malformed or
  corrupt stored seals and subsequent replay all fail closed. Missing,
  binding-mismatch, expiry and replay outcomes remain distinct. A same-email
  identity collision maps the exact conflict error and proves no extra user,
  identity or session survives. Member pagination exhausts tied microsecond
  cursors with exact UUID ordering and active-status filtering.
- Connection management and use authority derive from the shared capability
  matrix and hold share locks on membership, actor and workspace. Test dispatch
  locks its claim before the connection, accepts only the claimed state and
  persists the exact secret version. Controlled two-client races prove that
  rotation, revocation and authority suspension wait for admission, while
  mutation-first order rejects dispatch with no audit fact. Duplicate dispatch
  is rejected and completion requires matching durable dispatch evidence.
- Completion classification is a pure status/outcome/current-secret matrix.
  Durable replays distinguish full snapshots from strict historical pointers,
  validate workspace and connection identity, and reject impossible unfinished
  create or rotation claims. Missing, unavailable, revoked and incompatible
  connections retain separate outcomes. Workflow integration usage traverses
  every tuple-cursor page, including timestamp ties, final cursors, empty and
  cross-tenant pages, and invalid bounds.
- Identity and current connection integration suites now construct resources
  only after creating an owned disposable database, register each owner
  immediately, attempt every close before dropping, and aggregate cleanup
  failures. Historical pre-0021/pre-0037 connection databases exist only in the
  compatibility suite; generated-name collisions fail instead of forcing a
  drop. Explicit checkouts are released in `finally`, and destructive setup no
  longer touches an ordinary configured database.
- Verification after the final authority/dispatch module split: database unit
  tests pass 97 files / 522 tests in ordinary and seed-29146 shuffled order;
  database coverage is 99.24% statements, 98.5% branches, 100% functions and
  100% lines. The full PostgreSQL suite passes 82 files / 469 tests, and the
  final seven changed integration files pass 54 tests in seed-29146 shuffled
  order. Database and API typecheck/build, scoped strict ESLint and Prettier,
  15 architecture tests, all 24 built-package consumers and `git diff --check`
  pass. Q29 introduces no complexity hotspot or unexplained duplication; the
  repository-wide ratchets remain red only on earlier unfinished planned
  packages. No commit, push, deployment, provider request or other external
  operation was performed.

## Q30 evidence log

- Compatibility maintenance retains the original operation failure, attempts
  rollback once, releases a successfully rolled-back client as reusable and
  destroys it after rollback failure. Ten injected phase/cleanup regressions
  cover validation, acquisition, `BEGIN`, owner-role selection/read-back,
  operation, commit, rollback and release failures. A real max-one PostgreSQL
  pool proves uncertain rollback replaces the backend PID before reuse.
- Release mismatch errors keep the existing safe public message while carrying
  a bounded `mismatch` or `query_failure` category and the infrastructure cause
  only for query failure. Compact authority expectations have exact 128 KiB
  boundary coverage, hostile rejections remain fail-closed, and the database
  package treats catalog JSON as a trusted producer projection rather than
  implementing a second node-sdk canonicalizer. An independent node-sdk test
  recomputes the historical 0017 database fingerprint through the actual
  release producer.
- Database checkpoint parsing now owns internal join consistency: unique join
  and branch identities, bounded count policies, exact terminal outcomes,
  selected arrived branches, unsatisfied reasons and matching invocation
  status. Engine topology/plan admission and physical output-reference
  integrity remain at their existing owners. Shared V1/V2 fixtures pass both
  database and engine parsers; duplicate, missing, malformed and cross-field
  join/loop cases fail at the named boundary without a format or migration
  change. Named calculations keep the refinement below the complexity ratchet.
- Authoring compatibility options normalize in one private module before pool
  acquisition. Singular and rolling modes preserve exact epoch, fingerprint
  and compact catalog identity; mixed modes, mismatched catalogs, unbounded
  retained histories and readiness members without variants are rejected.
  Focused tests exercise invalid admission without checkout, locked singular
  and rolling selection, and valid factory assembly with an injected offline
  runtime. Replay still precedes current compatibility selection, while stored
  publication/lifecycle replay results must match their workspace and workflow
  claim identities.
- Workflow author authority derives from the shared capability matrix and now
  holds share locks on membership, actor and workspace through save, publish
  and lifecycle transactions. Controlled two-client PostgreSQL tests show a
  concurrent membership suspension waits for each command's durable mutation
  and exact single audit fact; the suspension is rolled back independently.
- Each authoring integration module owns a collision-failing disposable
  database. Resources are registered immediately, every closer is attempted
  before owned drop, setup/assertion and cleanup failures are aggregated, entry
  waits observe early operation settlement, and lock waits match the exact
  database/application plus real blockers under a five-second budget. Checked-
  out fixture transactions roll back before release and discard the client if
  rollback fails. The readiness suite's deliberate policy/grant/function/index
  drift is isolated from configured shared state.
- Publication atomicity uses a real integration connection and webhook trigger
  for every injected step. Fresh failures leave exact zero durable facts;
  reused-version projection rebuild failures preserve prior usage, trigger,
  version, pointer, audit, outbox and claim identities. Both impact queries
  traverse every one-item cursor page. Compatibility rollout and maintenance
  stories use separate databases, prior-head upgrade state is compared byte-
  for-byte, generated-name collisions never force-drop, and all 11 cases pass
  shuffled order independently.
- Retained-history publication continues to validate every ordered record while
  the workflow lock fixes the scan snapshot. First, middle and last corrupt V1
  rows and malformed retained V2 graph data all fail before mutation; semantic
  reuse, presentation-only edits, version numbering, concurrency and replay
  remain covered. No batching, cache or shortcut was introduced because Q40
  has not yet produced source/build-bound peak-memory, validation-duration and
  lock-hold measurements for equivalent small and near-limit histories. This
  is the required WQ-147 `KEEP` fallback, not an optimization claim.
- Verification: database unit tests pass 99 files / 539 tests in ordinary and
  seed-30149 shuffled order. Unit coverage is 99.24% statements, 98.5% branches
  and 100% functions/lines. The full PostgreSQL suite and its coverage lane pass
  82 files / 479 tests; integration coverage is 82.07% statements, 73.24%
  branches, 87.19% functions and 84.04% lines. The final seven authoring files
  plus compatibility rollout pass 48 tests in ordinary and seed-30148 shuffled
  order. Database/API typecheck and build, scoped strict ESLint and Prettier, 15
  architecture tests, all 24 built-package consumers and `git diff --check`
  pass. Q30 adds no unexplained clone, unused export or new/worsened complexity
  violation; repository-wide ratchets remain red only on earlier unfinished
  packages. No commit, push, deployment, provider request or other external
  operation was performed.

## Q31 evidence log

- Trigger projection explicitly treats graph-node disablement as execution-only:
  webhook and schedule identities remain materialized across absent, false and
  true graph flags, while stored trigger configuration retains its independent
  enable/disable lifecycle. Reconciliation now names and validates durable event
  identity separately from delivery identity, and materialization derives each
  resource disposition once before mapping it to status and health.
- Webhook construction validates compatibility material before pool acquisition.
  Delivery replay now always acquires the endpoint/dedupe advisory lock, reads one
  record using the database clock, returns an exact active replay, or deletes an
  expired replay before admission. Independent keyed and fingerprint contention,
  endpoint rotation, previous-secret expiry, graph-disabled ingress, identity
  mutation, and injected post-replay rollback cases observe exact durable state.
- Trigger-management commands use the shared `workflow:update` capability roles
  and hold share locks on membership, actor and workspace authority before the
  workflow/configuration mutation. A coordinated three-session PostgreSQL test
  proves a command that has linearized waits on the workflow lock while a later
  membership suspension waits behind its authority locks; the command commits
  one audit fact, the suspension then commits, and a later command is denied.
- Schedule construction validates compatibility before either pool lease, closes
  a partially acquired pair, keeps injected runtimes borrowed, attempts both
  owned closers, and reports combined close failures. Claim scanning uses the
  abort-aware platform transaction owner, propagates cancellation into tenant
  acceptance, validates every claim before cleanup, and retires the current and
  all later validated claims without letting cleanup failures replace the primary
  failure. Claim, occurrence persistence, retirement and batch accounting are
  separate named phases below the repository complexity threshold.
- A real cancellation interleaving blocks acceptance on the compatibility lock
  after the global claim commits, observes the exact PostgreSQL lock wait, aborts
  the owned backend transaction, and proves the lease is released with no run or
  occurrence leak before another worker reclaims it. A separate held-transaction
  regression proves `SKIP LOCKED` contention and the 1,000-attempt stress case
  releases every returned token even after assertion failure.
- Schedule commands expose identity/claim, target, health-transition, audit and
  completion phases in one transaction. Skip cursors advance only on a real
  disabled-to-enabled transition; active no-ops retain their cursor. Live quota
  backoff remains degraded across disable/enable, while expired deferral and scan
  failures recover to healthy with the current error cleared. Each integration
  case owns its workflow and admission state, so shuffled order no longer changes
  publication or quota eligibility.
- The exact 0080 migration upgrade retains the schedule row, live lease token and
  occurrence byte-for-byte while preserving helper ownership, RLS settings and
  grants. The unrelated 0083 artifact-expiry backfill has its own named assertion;
  published migration SQL remains unchanged. Prior-head webhook qualification
  likewise retains endpoint, secret, delivery and replay data through the full
  suffix and verifies API/worker secret boundaries.
- Recurrence keeps its pinned parser, strict IANA rules, DST gap/overlap identity,
  immutable interval anchor, cursor bounds, misfire behavior and fairness. Only
  persisted-column translation was centralized. WQ-161 correctly takes the KEEP
  fallback because Q40 has not yet produced the required source/build-bound
  allocation, event-loop and equivalence measurements; no performance claim or
  semantic optimization was introduced.
- Verification after the final phase split: database unit tests pass 101 files /
  555 tests in ordinary and seed-31156 shuffled order. Unit coverage is 99.24%
  statements, 98.5% branches and 100% functions/lines. The full PostgreSQL suite
  and its coverage lane pass 83 files / 488 tests; integration coverage is 81.89%
  statements, 73.39% branches, 87.10% functions and 83.89% lines. Nine focused
  unit/static files pass 48 tests in ordinary and seed-31154 shuffled order; the
  final seven integration files pass 33 tests in ordinary and seed-31155 shuffled
  order. Database/API/worker typecheck and build, 38 downstream worker trigger
  unit tests, scoped strict ESLint and Prettier, 68-table schema ownership, 15
  architecture tests, all 24 built-package consumers and `git diff --check` pass.
  Q31 adds no unexplained clone, unused export or new/worsened complexity finding;
  repository-wide ratchets remain red only on other unfinished packages. No
  commit, push, deployment, provider request or other external operation was
  performed.

## Q32 evidence log

- Stored execution values retain their iterative descriptor-safe clone and
  canonical serializer while direct tests now prove deep identity isolation,
  deep freezing, original-object mutation isolation, exact escaped and
  multibyte byte accounting, the separate 4 MiB JSONB backstop, numeric exponent
  distinctions, own `__proto__` keys, hidden and symbol properties, revoked
  proxies, aliases and active-path cycles. The independent oracle does not call
  the production serializer.
- Published-workflow compatibility is parsed before pool acquisition. The
  reader uses the shared repeatable-read workspace owner, and direct classifier
  and lifecycle tests cover every retained format, constructor failure,
  pre-abort, transaction cancellation and borrowed-runtime ownership. Its
  destructive PostgreSQL drift cases now run in fixture-owned disposable
  databases.
- Admission SQLSTATE inspection is operation-local, cycle-aware, guarded against
  proxies and accessors, and bounded to 16 cause links. Exact replay validation
  is represented as a discriminated mode, so request-only lookup cannot
  accidentally inherit checkpoint validation. Email and Slack destination,
  connection and secret pin eligibility use one explicit provider-requirement
  table and named predicates.
- Run-event reads select one materialized high-water mark and constrain the
  lateral page to that mark in a single SQL statement. Real concurrent-append
  tests prove stable middle, tail, empty and beyond-tail page metadata. Workflow
  run behavior covers the exact 1,000-node boundary and 1,001-node rejection,
  cancellation authority/reason failures, terminal-state precedence and exact
  persisted counts.
- Outbox checksum input is iteratively and descriptor-safely canonicalized with
  active-cycle detection, alias support, finite-number validation, a 4 KiB
  compact-input limit and a separate bound for PostgreSQL `jsonb::text`
  expansion. Golden hashes cover key ordering, Unicode and exponent forms;
  application request hashing has its own explicitly bounded helper instead of
  borrowing the outbox wire limit.
- Dispatcher claims parse, map and freeze all returned material before COMMIT.
  Decoder failure rolls back, rollback failure poisons the client, and a failed
  COMMIT acknowledgement is treated as an uncertain outcome and disposes the
  connection. Readiness proves every required mutable column, forbids immutable
  and table-wide mutation, checks exactly the two permissive role policies, and
  validates the ready nonunique btree key order and exact predicate. Claim and
  readiness logic live behind cohesive private modules, clearing Q32's source
  and factory complexity regressions without changing ratchet baselines.
- Transport fixtures acquire resources only inside protected initialization,
  use per-file disposable databases for routine cases, preserve the explicit
  Q11 shared benchmark mode, and attempt all partial-setup closers. Rollback
  proofs assert both business data and receipts are absent; completion callbacks
  are suppressed after incomplete receipt work; exact receipt identity and
  cross-tenant hiding are independently asserted.
- The lost-COMMIT-ACK proxy now bounds frame and buffer sizes, rejects unsupported
  startup negotiation, contains parser errors, settles its armed waiter on
  close, and drains peer sockets after stopping the server. The Q11 barrier has
  explicit dependency, configuration, exclusivity and timeout seams. Lost-ACK
  tests observe the durable operation immediately and verify that every owner is
  asked to close.
- Verification after the final module extraction: database unit tests pass 103
  files / 597 tests in ordinary and seed-32163 shuffled order. Unit coverage is
  99.27% statements, 98.52% branches and 100% functions/lines. The full
  PostgreSQL suite passes 83 files / 497 tests; its coverage lane passes the same
  tests at 81.9% statements, 73.44% branches, 87.32% functions and 83.9% lines.
  The final 12-file integration cluster passes 95 tests in seed-32164 shuffled
  order. Database/API/worker typecheck and build, 58 files / 739 downstream
  worker unit tests, scoped strict ESLint and Prettier, 68-table schema ownership,
  15 architecture tests, all 24 built-package consumers and `git diff --check`
  pass. Q32 adds no unexplained clone, unused export or new/worsened complexity
  finding; repository-wide ratchets remain red only on other unfinished
  packages. No commit, push, deployment, provider request or other external
  operation was performed.

## Q33 evidence log

- Operator transactions now reject pre-aborted work before checkout, release a
  client delivered after a checkout abort, and destroy an owned in-flight
  backend for cancellation during `BEGIN`, command execution or `COMMIT`.
  Command rows are decoded before commit, malformed rows roll back, rollback
  failure preserves the primary cause and poisons the client, and a rejected
  commit acknowledgement is treated as uncertain without a rollback claim.
  Runtime close memoizes its first promise and failure while the underlying pool
  drains, so concurrent and sequential callers cannot close telemetry ownership
  twice.
- Operator replay input and evidence use one descriptor-safe bounded plain-JSON
  serializer with their distinct 65,536-byte and 4,096-byte limits. It preserves
  accepted values canonically without invoking getters, proxies or `toJSON`,
  accepts aliases, and rejects cycles, excessive depth/member counts, symbols,
  nonfinite numbers, functions, `BigInt` and other unsupported material before
  command authority is acquired. Exact ASCII/Unicode boundaries, stable stored
  evidence and every facade SQL/argument mapping have direct regressions.
- Persisted command records use explicit private schemas and reject invalid
  dates. Validated conflict results commit their audit before the public conflict
  error is raised. Replay construction validates compatibility before acquiring
  its database; replay and unknown-outcome public signals are validated; exact
  outbox/payload/request identities, compatibility and projection failures,
  checkpoint/admission/completion failures, duplicates and stale evidence have
  independent negative matrices. Historical unknown outcomes remain unchanged.
- The owned schedule slice proves immutable replay lineage, duplicate delivery,
  fail-after-completion stability and a real completion-versus-failure race:
  exactly one terminal request/command state wins, with either one committed run
  and receipt or neither. Current-head execution-command tests prove API/worker
  denial, operator readiness, stale-fence dry-run nonmutation, exact replay and
  conflict audit counts, and the 100/101 due-work boundary across two bounded
  resume pages.
- Retention lock cleanup normalizes hostile, primitive and undefined failures
  without letting inspection bypass disposal. Operation, unlock and synchronous
  release failures retain their order, and permits return after every failure.
  Tests cover larger pools, FIFO handoff, multiple aborted queued waiters, late
  checkout, failed checkout/lock, lock-grant cancellation, capacity recovery and
  real PostgreSQL lock cancellation.
- Artifact metadata primitives are shared privately across upload and execution
  writers while their public contracts remain distinct. Upload idempotency hashes
  once; quota-error inspection is guarded; finalization forwards cancellation to
  both short transactions and rechecks it after external verification while
  keeping the workspace lifecycle lock until noncooperative provider work settles.
  The second authority, lifecycle and exact-metadata validation remains the
  database authority; the client-clock expiry preflight was removed.
- Artifact boundary tests cover actor/workspace identity, passthrough context,
  delimiter and numeric/hash/date limits, malformed rows, empty aggregates,
  finalized replay and lifecycle transitions. Disposable fixtures now acquire
  resources only after database creation, attempt all teardown, bracket deadlines
  with database timestamps, and force real `SKIP LOCKED` overlap. Retention cases
  reset owned artifact/control state transactionally, eliminating shuffled-order
  leakage; the prior-head media fixture always attempts both pool and temporary-
  directory cleanup.
- Verification: database unit tests pass 106 files / 681 tests in ordinary and
  seed-3303 shuffled order. Unit coverage is 99.27% statements, 98.52% branches
  and 100% functions/lines. The full PostgreSQL suite and coverage lane pass 83
  files / 502 tests; integration coverage is 81.66% statements, 73.14% branches,
  87.34% functions and 83.59% lines. The final 15-file unit/static cluster passes
  114 tests in ordinary and seed-3301 shuffled order; the final 10-file
  integration cluster passes 79 tests in ordinary and seed-3302 shuffled order.
  Database/API/worker/operator typecheck and build, 60 operator-command, 48 API
  artifact and 112 worker owner tests, scoped strict ESLint, repository Prettier,
  68-table schema ownership, 15 architecture tests, all 24 built-package
  consumers and `git diff --check` pass. Q33 adds no unused export; broader
  complexity, duplication and the two retained node-sdk type exports remain
  assigned to unfinished tooling packages and no ratchet baseline was changed.
  No commit, push, deployment, provider request or other external operation was
  performed.

## Q34 evidence log

- Failure-notification completion, destination loading and dispatch fencing now
  parse attempt numbers in the persisted 1–10 domain before transaction
  checkout. Claim, recovery and completion share the same maximum-attempt
  validator. Retry delay is a bounded 0–3,600-second safe integer: zero remains
  compatible with terminal completions but is rejected before an actual retry
  mutation. Negative, fractional, nonfinite and out-of-range controls have
  direct no-checkout/no-mutation regressions, while minimum and maximum valid
  boundaries retain their intended behavior.
- Destination audit writes take an explicit target identity. Destination
  create/version/status facts use `failure_notification_destination`; workflow
  policy set/clear facts use `workflow`. Repository evidence checks exact actor,
  request, trace, target and metadata values and proves that status and policy-
  clear no-ops complete idempotently without fabricating audit events. No
  historical audit rows were rewritten.
- Durable destination record translation is isolated behind one private codec
  and read seam with explicit projected columns. Persisted and replayed records
  reject a provider kind that disagrees with configuration. Locked reads now
  acquire the destination row in a separate statement before reading its current
  version, so a concurrent optimistic append loser observes the committed
  pointer and returns a version conflict instead of a snapshot-dependent not-
  found result. The public seven-method repository and its visible command phase
  ordering remain unchanged.
- Actual repository tests cover owner/admin/builder/operator/viewer capabilities,
  inactive membership/user/workspace states, cross-workspace workflow and
  destination visibility, authorization-before-replay, historical create and
  append replay, request-hash conflict, status no-op, absent-policy clear and the
  two-client append race. Read/list output, immutable historical snapshots and
  policy target identity are asserted through the public methods.
- Real delivery tests independently reject wrong aggregate ID/type, queue job,
  schema version, supplied/stored checksum, tampered payload, invalid context and
  context-checksum drift without claiming the intent. Busy claimed/dispatching,
  terminal, exact due-boundary and lowered-attempt-ceiling paths have distinct
  durable outcomes. Pinned configuration, destination disable, current-secret
  rotation, connection revocation, provider mismatch, auth mismatch and exact
  retry binding replay are exercised separately. Credential-access audit retains
  only stable connection/worker/secret identifiers and purpose, with no sealed
  bytes, recipient or provider response.
- Completion failure injection after the intent update, retry outbox insert and
  audit insert proves transaction-wide rollback at each boundary. Pre-checkout
  and lock-blocked cancellation perform no completion write. A lost commit
  acknowledgement surfaces as uncertain while a repeated completion observes
  the single committed delivered row and audit fact as stale, rather than
  treating the operation as uncommitted.
- Verification: database unit tests pass 108 files / 726 tests in ordinary and
  seed-3403 shuffled order. Unit coverage is 99.27% statements, 98.52% branches
  and 100% functions/lines. The full PostgreSQL suite passes 83 files / 511 tests;
  its coverage lane passes the same tests at 81.97% statements, 73.68% branches,
  87.54% functions and 83.88% lines. The final three notification unit files pass
  57 tests in ordinary and seed-3401 shuffled order; the two destination/delivery
  integration files pass 21 tests in ordinary and seed-3402 shuffled order.
  Database/API/worker typecheck and build, 11 API destination tests, 68 worker
  notification tests, scoped strict ESLint, repository Prettier, 68-table schema
  ownership, 15 architecture tests, all 24 built-package consumers and
  `git diff --check` pass. Q34 adds no unused export, unexplained clone or
  new/worsened complexity finding; broader ratchets remain red only on already
  unfinished packages. No commit, push, deployment, provider request or other
  external operation was performed.

## Q35 evidence log

- Production completion projection is now an exhaustive outcome switch with
  unchanged durable statuses and null conventions. Suspended outcomes remain
  narrowed through their private phase without a cast. Claim scope projection
  normalizes optional branch and iteration paths once, and structured-loop
  selection indexes loop ID plus canonical ancestry locally while retaining the
  exact branch prefix, active ordinal, cardinality and checksum predicates. A
  200-loop comparison measured 6,011.78 ms for the prior repeated scan versus
  30.66 ms for the indexed lookup; no end-to-end latency claim is made.
- Node-attempt admission rejects aborted and malformed claim/load/dispatch/
  heartbeat/completion inputs before any checkout through an injected runtime.
  Independent PostgreSQL cases cover expired lease, changed owner, changed
  token and wrong current attempt with zero terminal mutation. Exact and changed
  success, ordinary failure and executor-failure replay fields are checked both
  before and after coordinator retry decision. Suspension duplicate identity is
  the durable `node.waiting` event: a changed requested duration does not
  recompute an already fixed wait, and replay remains stable across later run
  control and resume.
- The former mixed claim scenario is split into independently seeded claim,
  connection, completion/replay and downstream-value cases. Its generalized
  fixture takes explicit input, side-effect and worker options; suspension state
  is restored in `finally`. Injected failures immediately after attempt update
  and after continuation-outbox insertion prove that attempt, node, event,
  receipt and outbox writes roll back together. A delivery mismatch commits
  exactly one separate security fact. One shared hard-coded conformance fixture
  proves root, explicit-empty, colon-bearing, branch and nested-iteration key
  bytes in both database persistence and the workflow engine.
- Preview output validation now delegates solely to the canonical descriptor-
  safe stored-value serializer/parser and returns `false` for every invalid or
  hostile value without invoking accessors. Empty keys, null/null-prototype
  objects, artifact envelopes, getters, throwing/revoked proxies, functions,
  symbols, sparse arrays, excessive depth and byte limits have direct tests; the
  worker handler proves admitted output reaches completion and invalid output
  follows `preview.output_invalid`.
- Terminal preview replay binds the exact attempt/run pair, delivery receipt,
  both terminal statuses and canonical output or exact safe error code. Exact
  replay emits no new audit/usage facts; changed output, error, run or delivery
  fails closed. Safe reconciliation proves a replacement delivery can claim,
  complete and replay exactly while the superseded original delivery cannot be
  relabeled a duplicate. New output is passed as canonical JSON text directly
  to `jsonb` once; raw rows are objects with exact escaped and artifact values,
  while retained double-encoded rows remain readable and reusable.
- Preview claim, dispatch and heartbeat enforce database-time ownership:
  provider dispatch and renewal require a live current lease, renewal and the
  reconciliation wake-up are capped by the immutable execution deadline, and a
  queued post-deadline claim terminalizes atomically before provider authority.
  Lease expiry alone prevents new provider work but does not erase truthful
  completion from the unchanged owner/token until reconciliation replaces its
  fence. Unsafe dispatch ambiguity still wins over timeout, and a live worker is
  rescheduled for truthful evidence.
- Preview acceptance applies bounded descriptor-safe JSON admission before Zod
  recursion and exposes an ordinary immutable snapshot to Drizzle. Read queries
  load only their public projection. Status-pair lookup is one immutable,
  prototype-safe module constant; claim projections no longer load unused lease
  expiry or run side-effect fields. The new admission/read seams and extracted
  terminal phases keep Q35 from adding a source clone or complexity hotspot.
- Preview integration fixtures own disposable databases, construct monitored
  stores only after database creation, reserve clients for explicit
  transactions, split permission failures into independent transactions, and
  aggregate partial cleanup. Populated 0069 upgrade evidence covers queued and
  terminal deadline backfill, pins, retention, RLS and rerun. Retained 0023 rows
  execute through the current reader. Reconciliation separates execution from
  retention time, artifact deletion has bounded lock/query ownership, corruption
  setup is asserted, and every workspace mutation is restored safely.
- Verification on final source: database unit coverage passes 110 files / 746
  tests at 99.27% statements, 98.52% branches and 100% functions/lines. The full
  PostgreSQL integration coverage lane passes 83 files / 522 tests at 82.13%
  statements, 74.17% branches, 87.70% functions and 84.03% lines. The final
  three database unit files pass 24 tests, workflow-engine key conformance passes
  five tests, the preview handler passes 31 tests, and the final eight integration
  files pass 51 tests in seed-350192 shuffled order. Repository build and
  typecheck, scoped strict ESLint, repository Prettier, 68-table schema ownership,
  15 architecture tests, all 24 built-package consumers and `git diff --check`
  pass. Q35 adds no unexplained clone or new/worsened complexity finding; broader
  ratchets remain red only on unfinished packages. The ordinary full integration
  suite passes; a deliberately repository-wide shuffled run still exposes known
  order coupling in five unrelated retention/lifecycle/historical suites. Full
  ESLint exhausted its configured 8 GiB heap, while the complete Q35-owned lint
  cohort passes. No commit, push, deployment, provider request or other external
  operation was performed.

## Q36 evidence log

- Historical source-text smoke checks remain distinct from SQL behavior and
  catalog evidence. A bounded named-function extractor now makes the semantic
  fixture insensitive to harmless whitespace while deliberate lock, page-bound,
  maintenance-grant, old-overload, legal-hold and tombstone mutations each fail
  at their owning assertion. Existing Q11 transaction/authorization cases remain
  the behavioral owners rather than being duplicated. Current-head catalog
  evidence additionally proves that the obsolete three-argument regional lag
  function is absent, the exact four-argument replacement is owner-defined with
  fixed search path and row security, maintenance can execute it, and API cannot.
- Published `0006_execution_vocabulary.sql` and
  `0007_execution_runtime.sql` bytes remain unchanged. The migration runner now
  supplies their missing owner-only FORCE-RLS bracket inside the same
  transactional migration application: only `workflow_runs`,
  `idempotency_records` and `run_events` are temporarily unforced, and every
  successful path restores FORCE before recording the migration. A mocked
  ordering test pins the exact bracket around the original SQL. A disposable
  exact-0005 upgrade populated canceled runs, claimed idempotency records and
  accepted events plus retained rows and JSON in two workspaces through the API
  role. The real migration login then assumed the `NOINHERIT`/`NOBYPASSRLS`
  owner, transformed every named row through 0006 and 0007, preserved unrelated
  values, restored all three FORCE flags and retained cross-workspace hiding.
- A two-client 0010 regression acquires the real OIDC advisory lock, observes
  the inserting backend in `pg_stat_activity`, advances past a one-second expiry
  while it remains blocked, and proves the historical function conservatively
  rejects with SQLSTATE 54000 and rolls back the candidate at exactly 10,000
  stored rows. Forward migration `0089_oidc_capacity_lock_time.sql` captures
  `clock_timestamp()` immediately after lock acquisition. Repeating the same
  observed wait then admits exactly one candidate, leaves exactly 10,000 active
  rows, and preserves the 1,000-row cleanup, 10,000-active and 20,000-total
  bounds. Catalog checks retain the owner, SECURITY DEFINER, trusted search path,
  enabled trigger and no PUBLIC execution. Migration history, execution plan,
  readiness and retained suffix fixtures now name 0089 as the current head.
- Migration mode dispatch, database-size preflight, resumable progress, online
  execution and the historical transactional bracket now live behind one
  private migration-application interface. The caller retains lock ownership,
  transaction construction, progress reporting and cleanup. This extraction
  removed the initially detected Q36 file/function complexity regression without
  changing the public runner interface. Regional admission tests reset their
  singleton before each case, so the new catalog scenario and existing behavior
  remain stable under shuffled execution.
- Verification on final source: database unit coverage passes 112 files / 759
  tests at 99.27% statements, 98.52% branches and 100% functions/lines; the full
  unit suite also passes seed-360205 shuffled order. The full PostgreSQL
  integration coverage lane passes 85 files / 525 tests at 82.16% statements,
  74.18% branches, 87.73% functions and 84.06% lines. The final four historical
  upgrade, OIDC, identity and regional files pass 36 tests in seed-360206
  shuffled order; migration runner/plan and execution-mode focused cohorts also
  pass. Repository build and typecheck, scoped strict ESLint, repository
  Prettier, 68-table schema ownership, 15 architecture tests, all 24 built-package
  consumers, documentation validation and `git diff --check` pass. Q36 adds no
  unexplained clone or new/worsened complexity finding; broader ratchets remain
  red only on unfinished packages. No commit, push, deployment, provider request
  or other external operation was performed.

## Q37 evidence log

- One bounded asynchronous child-process owner now backs built self-reference
  imports and clone detection. It validates deadlines, captures exact terminal
  evidence, terminates the detached POSIX process group, escalates from TERM to
  KILL after a bounded grace period and does not resolve until the group has
  been reaped. Success, nonzero exit, spawn failure, timeout and a parent plus
  TERM-ignoring grandchild are directly exercised without exposing inherited
  environment values in diagnostics.
- Browser dependency and documentation fixtures register cleanup immediately
  after acquiring their exact temporary root. Controlled-parent tests prove
  both successful setup and injected setup failure remove only the owned path.
  Documentation links with an empty decoded path now resolve against the source
  document itself; fragment-only, query-plus-fragment, encoded, repeated-slug,
  missing-fragment, invalid-percent and repository-escape cases are covered.
- Complexity keys now include stable lexical ownership and deterministic local
  disambiguation. Three same-line, same-method observations across duplicate
  class owners survive inventory independently, and worsening one reports only
  that identity. The single historical coordinator arrow identity was renamed
  without changing its reviewed ceiling; no blanket baseline increase was made.
- Clone evidence rejects absent/empty/malformed reports, invalid or nonfinite
  totals, malformed clone records, duplicate evidence and total/evidence count
  mismatch before aggregation. The clone tool itself has an independent bounded
  deadline. Istanbul merging validates every report, including the first, with
  exact map/counter keys, record shapes, safe nonnegative integer hits, branch
  arity and safe sums before producing an owned copy.
- Verification on final Q37 source: the seven focused files pass 44 tests; all
  22 infrastructure test files pass 174 tests. The real built-export gate passes
  nine tests and all 24 consumer cases; documentation passes 18 tests and 879
  links across 179 files; database coverage merge passes four tests and merges
  196 files. Repository build, recursive typecheck, Prettier and scoped strict
  ESLint pass. Complexity and duplication execute to completion and accurately
  reject findings introduced by later unfinished packages, with no Q37-owned
  collision, malformed-evidence or subprocess failure. No baseline was raised
  to hide those findings. No commit, push, deployment, provider request or other
  external operation was performed.

## Q38 evidence log

- The readiness validator now accepts only the canonical workload
  `CMD-SHELL` command and rejects missing, weakened, alternate or shell-bypass
  forms. A controlled live process proves the command fails before readiness,
  succeeds while readiness is asserted and fails again after revocation. The
  deployment validator is import-safe and separately testable; it enforces the
  exact workload/command inventory, safe desired counts, disjoint configuration
  and secret namespaces, and the distinct scaling-signal contract in addition
  to the rendered-manifest constraints.
- External-platform evidence uses one normalized versioned contract and a
  dedicated deep validator. Evidence binds SHA-256 identities for the platform,
  workload and autoscaling contracts; collector identity and collection times;
  independently authenticated raw references; regional image observations;
  per-object configuration, secret and KMS permissions; exact scaling settings;
  safe positive migration concurrency; migration task identity, outcome and
  ordered times; and recovery-fence sources. Missing, self-attested, stale,
  fractional, zero, malformed and cross-object evidence fails closed. The CLI
  explicitly states that reference shape is locally validated while the raw
  provider observations still require independent authentication.
- Rendered startup smoke now owns every acquired resource through one
  acquisition-order cleanup stack. All child processes are bounded and reaped;
  Docker containers are created before start and registered by exact ID;
  uncertain create failures preserve a manual-cleanup diagnostic; TLS roots,
  servers, requests and sockets are registered immediately; response bodies are
  bounded; URLs use structured setters; and primary plus cleanup failures are
  retained together. Concurrent runs have unique names. The worker executes the
  full rendered command and must remain running, rather than substituting a log
  readiness assertion. Local image-ID evidence is labelled honestly and is not
  presented as registry attestation.
- Final verification passes `pnpm deployment:check`, all 58 ECS infrastructure
  tests, deterministic rendering, repository build and recursive typecheck,
  repository Prettier, documentation validation (18 tests, 879 links across 179
  files), scoped strict ESLint and `git diff --check`. A freshly built local
  image and exact disposable PostgreSQL database migrated through 0089 passed
  both the core and `merge_v3_activation` rendered-task smoke cohorts, including
  the negative KMS path, API readiness and the exact worker health command. The
  generated containers, database, image and temporary activation helper were
  removed afterward; the shared database was untouched. No AWS call,
  deployment, provider request, commit, push or other external operation was
  performed.

## Q39 evidence log

- The HTTP exercise runner validates every input and reserves the exact evidence
  destination exclusively at mode `0600` before the first request. Its versioned
  `started` record survives abrupt process loss; completed and interrupted
  records atomically replace only that owned reservation, and a failed initial
  write removes only its newly opened file. Existing, invalid and unusable
  destinations all produce zero requests. Evidence contains digests rather than
  bodies, paths, queries or credentials, and interrupted evidence retains
  reconciled counts plus an explicit operator-cleanup requirement.
- Open-loop scheduling now has injected clock, sleep, fetch, deadline, identity
  and evidence seams. Concurrency is a safe integer, fractional rate/duration
  retains the documented floored request count, and a slot delayed beyond its
  interval is skipped instead of emitted as a catch-up burst. Each attempted
  request receives exactly one primary outcome. HTTP status, network failure,
  policy mismatch and bounded problem-body diagnostics remain separate, so
  status totals equal completions and the server-failure ratio cannot exceed
  one. Tests cover exact count/rate arithmetic, maximum live requests, both skip
  classes, empty and interrupted runs, the 30-second request signal, manual
  redirects, streamed-body bounds, cancel/read failures and secret redaction.
- ADR 036 retains one opaque random `service.instance.id` per telemetry writer
  while the collector continues removing host, PID and command identity. Worker
  starts are per-writer start-time gauges and trigger an immediate bounded flush;
  the existing greater-than-five-in-15-minutes policy counts distinct recent
  writers. Replica admission, lag and source timestamp use stable label sets;
  rules select the newest writer, reject source age beyond the qualified
  60-second SDK + five-second batch + 15-second scrape envelope, fail closed on
  missing timestamps and ignore an older cached paused writer after a healthy
  replacement. Collector series expire after 20 minutes, retaining the complete
  alert window while bounding obsolete writer cardinality.
- The pinned Prometheus image validates all 24 rules plus fixtures for no
  traffic, below/at threshold, five versus six restarts, exact `for` durations,
  counter reset, missing partial series, fresh/stale cached observations and
  old/new writer replacement. The pinned collector validates the updated
  configuration. A disposable local collector/Prometheus pipeline then accepted
  two same-service writers and one restart, preserved three exact writer series,
  stripped the injected prohibited host/process values, produced a promtool-valid
  scrape, and returned counter sum 10, gauge maximum 9, histogram count 6 and
  histogram sum 2. The ordinary read-only Prometheus service also started with
  its owned writable tmpfs; every created container/network was removed.
- Final verification passes the 22 exercise tests, two qualification-contract
  tests, 112 observability tests, 100 retention tests, 18 focused worker startup
  tests, repository build and recursive typecheck, scoped strict ESLint,
  repository Prettier, documentation validation and `git diff --check`.
  Complexity and duplication execute and report only later unfinished-package
  findings, with no Q39-owned finding or baseline increase. No exercise HTTP
  target, deployed collector, pager, AWS/provider API, commit, push, deployment
  or other live external operation was used.

## Q40 evidence log

- Schema v5 binds every artifact to source snapshots taken before build, after
  build and after all workloads, plus hashes of all 2,839 generated `dist`
  files before and after measurement. Build-time source drift aborts before
  workloads; later source or build drift produces partial evidence rejected by
  the shared producer/comparator/full-run validator. The output path is reserved
  exclusively before build, validated before write, and cleaned only through
  exact owned-file identity.
- Manifest validation now returns one bounded coherent configuration: safe
  integer rounds, warmups and concurrency; positive fixture populations; string
  argv/file values; explicit database scopes; and exact shared participant and
  operation scopes. The current exclusive-file overlap protocol accepts only
  concurrency one. Every command and the whole benchmark have checked deadlines,
  bounded output and owned process-tree cancellation. All rejection observers
  attach at promise creation; barrier, sampler, partial-connect, plan-client,
  collector and monitor failure paths drain and attempt every acquired owner.
- Process samples must observe a real workload at least once while allowing
  terminal zero-process and genuine zero-CPU samples. Each round freezes one
  raw-sample snapshot before deriving peaks and RSS trends. PostgreSQL counts
  are honestly named statement executions, scoped by database OID and retained
  as fixture-reset, warmup, measured and unclassified phases that reconcile to
  the whole scenario. Runner-owned targets are sampled directly. Runtime
  evidence includes actual PostgreSQL/server/extension/settings/role identity,
  including the 20,000-entry `pg_stat_statements` capacity; six exact structured
  maintenance-role outer-function plans retain their internal-plan limitation.
- The 64 benchmark tests cover immediate rejection, undefined failure,
  partial acquisition, sibling draining, stuck-query cancellation, barrier and
  process-tree cleanup, command/overall deadlines, source/build drift,
  pre-existing output protection, strict manifests, absent versus terminal-zero
  observations, SQL phase reconciliation and exact plan/runtime contracts. The
  schema-v5 checked-in manifest validates independently.
- Disposable run `2026-09-13t17-57-30-944z-28200-1dae2183` completed all eight
  scenarios with one warmup and five measured rounds. Its artifact SHA-256 is
  `000b0ffc3a1fc9b65aa37cde28af76bcd5a8dd574961813720500c81b8507b67`;
  source `e34c938e…` and build `66e9d2b2…` stayed stable, every scenario had
  positive process observations, scoped SQL totals were positive on the correct
  base or target database, three instrumented queries and six structured plans
  were present, and PostgreSQL 18.6/`pg_stat_statements` 1.12 runtime identity
  was retained. Independent self-comparison passed and no run-owned container or
  volume remained. The evidence showed no specific regression, so PF-06 remains
  unchanged and no noisy automated latency budget was added. No commit, push,
  deployment, provider request or live external operation was performed.

## Q41 evidence log

- The existing ordinary `quality` job name and 15-minute bound remain intact.
  It now owns explicit `pnpm build`, `pnpm architecture:check`,
  `pnpm built-exports:check` and `pnpm quality:local:check` steps, with build
  ordered before built-export closure. Full service-backed `quality:local` is
  deliberately absent. The integration job invokes the existing mutation owner
  through the named `mutation:check` package script rather than duplicating its
  command.
- `validate-ci-gates.mjs` parses the workflow YAML and validates named package
  scripts rather than workflow whitespace. It requires exactly one ordinary CI
  and local `check` owner for each missing gate, enforces build-before-export
  order, proves `performance:local:check` remains beneath the local-runner
  contract, rejects unknown direct package scripts, and states/validates the
  full-local and mutation exclusions. Seven fixtures cover success, omission,
  duplication, both ordering surfaces, unknown scripts, opaque root commands,
  missing local ownership, forbidden full qualification, misplaced mutation
  execution and nested-performance drift.
- The renamed mutation owner was reconciled with the existing CI/local service
  contract. A combined gate run exposed a macOS process-probe edge: `kill(-pid,
  0)` can report `EPERM` while a just-terminated process group still exists.
  The existence probe now treats `EPERM` as present while actual termination
  signals continue treating it as failure. The deterministic injected regression
  failed before the fix and passes afterward; the real 30 ms timeout/reap case
  passed 100 consecutive repetitions.
- Local verification passes the 7 policy tests and real validator, 15
  architecture tests plus both graph validators, 9 built-export tests and all
  24 consumers, 35 local-runner/mutation contract tests, and all 64 performance
  contract tests plus manifest validation. This proves the checked-in mapping
  locally only. No hosted PR run or branch-protection query was performed, so
  neither is claimed; no protected check was renamed and no commit, push,
  deployment or external operation occurred.

## Q42 evidence log

- The backend blueprint's exhaustive directory tree is now explicitly an
  illustration of process/capability boundaries and points to the current
  codebase map. It no longer directs contributors to add empty web, module or
  layer folders simply to reproduce an obsolete sketch.
- Every public draft save/publication occurrence now requires ADR 011's strong
  opaque `If-Match`; the numeric `expectedRevision` term remains only as the
  decoded internal PostgreSQL compare-and-swap value in the valid SQL recipe.
  Publication now distinguishes atomically stored immutable/version-derived
  indexes, desired trigger configuration, pointer, activation transition and
  reconciliation intent from the trigger owner's later effective-resource and
  activation convergence. No accepted ADR or runtime contract changed.
- The current status and codebase map point to this live whole-codebase record
  while preserving Q9's exact dated run counts and candidate identity. The
  governance runbook points to the dated policy/solo-maintainer exception and
  explicitly leaves hosted settings externally unverified. The historical
  complexity register corrects the SDK registry description and limits its
  completeness claim; release/security guidance names the ordinary PR gates;
  test-confidence separates its earlier lost-COMMIT limitation from the later
  named wire-proxy proof and records current source/artifact fail-closed rules.
  The already-landed external-platform, local-quality and performance guidance
  remains paired with WQ-218, WQ-223–WQ-230 and WQ-231 rather than being
  relabeled as new execution.
- `pnpm docs:check` passes all 18 documentation tests and validates 886 local
  links across 180 files. Focused Prettier and `git diff --check` pass. No
  historical evidence count, source, migration, ADR, cloud setting, provider,
  GitHub setting, commit, push or deployment was changed or requalified.
