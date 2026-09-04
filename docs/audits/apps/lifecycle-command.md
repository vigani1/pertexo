# `@pertexo/lifecycle-command` implementation and architecture audit

## Review identity and conclusion

- **Audited implementation commit:**
  `7e4b37840a2b86c591046e16f1de834e8da2db79`
- **Audited implementation tree:**
  `8481ebf86f4b36ff70687f86a2bb7933a00d65b8`
- **Production scope:** all 4 source files and all 331 physical source lines.
- **Test scope:** both test files and all 229 physical test lines.
- **Tooling scope:** `package.json`, both TypeScript configurations, and the
  Vitest configuration (5 files and 49 physical lines).
- **Granular certification:** every one of the application's 11 tracked files
  and 609 physical lines was read in full. Every export and meaningful
  internal callable was reviewed for responsibility, callers, invariants,
  branches, errors, shutdown, resource ownership, naming, readability,
  duplication, reuse, abstraction depth, test evidence, and applicable
  security and operational concerns. Findings are complete, not a top-N list.
- **Architecture sources:** the authoritative backend plan; ADRs 013, 021,
  022, 025, and 027; and the database, artifact-store, and observability
  component audits.
- **Audit status:** granularly certified for the pinned tree.
- **Implementation status:** one medium-priority shutdown correctness defect
  and one medium-priority assurance gap remain open.

This is a small, cohesive deployment adapter. It owns configuration,
composition, process signals, readiness marking, polling, metrics, and ordered
resource shutdown; it delegates lifecycle-command durability, leases, fencing,
and ledger reconciliation to deep package modules. Its package dependencies and
role-specific database entrypoint accurately express that boundary. There is
no unnecessary framework, middleware layer, class hierarchy, generic
repository, or speculative abstraction here.

The main defect is in shutdown classification. A signal received while the
coordinator is processing an operation is propagated by the database package
as `signal.reason`. `runLifecycleCommandWorker` catches every rejection as an
operation failure and later throws an `AggregateError`, so `main.ts` reports a
fatal process failure and sets exit code 1 for an expected shutdown. An idle
signal exits cleanly because the delay helper resolves on abort. The distinction
depends on timing and is not covered by the current tests.

## Evidence collected

| Check | Result |
| --- | --- |
| `pnpm --filter @pertexo/lifecycle-command test` | 2 files and 6 tests passed |
| Package build and test typecheck | Passed |
| Isolated application lint | Passed with the repository's 8 GiB lint heap |
| Full `src/**/*.ts` unit coverage | 45.33% statements, 65.38% branches, 44.44% functions, 47.22% lines |
| Active-operation signal probe | Rejected with `AggregateError: Lifecycle command worker did not stop cleanly`, containing the expected signal reason |
| Repository pre-push gate | Passed after the preceding database certification commit |
| Baseline application diff | Empty against the audited implementation commit |

Coverage is low primarily because `main.ts` and `readiness-marker.ts` are not
executed and because configuration failure branches are sparse. The six tests
are useful, but their count must not be mistaken for complete process-lifecycle
assurance.

## Architecture and dependency direction

The application's Interface is intentionally tiny: `main.ts` is the executable
entrypoint, `parseLifecycleCommandConfig` owns environment composition,
`runLifecycleCommandWorker` owns the service lifecycle, and the readiness
marker is a private deployment adapter. Dependencies point from the app to
`artifact-store`, the database's `./lifecycle` authority surface, and narrow
observability subpaths. No package imports the app, and the app does not reach
through package-private source files.

The resource graph is explicit. Telemetry is created first; dynamic imports
defer heavier runtime construction until configuration succeeds; the dual-
region ledger and database coordinator are constructed once; and the runner
owns readiness and shutdown. Cleanup is serial and attempts every resource,
preserving multiple failures in an `AggregateError`. The bootstrap guard avoids
closing resources twice after the runner has taken ownership. Calling
`telemetry.start()` in both bootstrap and the runner is redundant but safe and
idempotent by the observability contract, so it is not an independent defect.

The fixed `/tmp/pertexo-lifecycle-command-ready` marker is appropriate for one
instance per container and is written with mode `0600`. Deployment must not run
multiple instances in one shared filesystem namespace. The current container
model supplies that assumption; no extra path abstraction is justified today.

## Complete file and callable review

| File | Callables and assessment |
| --- | --- |
| `src/config.ts` | `parseLifecycleCommandConfig` composes strict database, dual-region ledger, telemetry, role, poll, lease, lock, statement, and external-operation settings. `environmentSchema.superRefine` proves the combined timeout envelope fits inside the lease and requires production telemetry. Names and bounds are clear. Keep. |
| `src/main.ts` | `bootstrap`, `stop`, and the terminal catch own dynamic composition, signal registration/removal, fallback cleanup, sanitized fatal logging, and exit status. Ownership is readable and the `workerInvoked` guard prevents duplicate cleanup. Normal active-operation abort is misclassified under LC-001. Entry/bootstrap branches lack direct tests under LC-002. |
| `src/readiness-marker.ts` | `createLifecycleCommandReadinessMarker`, `clear`, and `mark` form a deliberately shallow filesystem adapter. Forced removal and mode `0600` are appropriate. Its real filesystem behavior and shared-namespace assumption should be covered under LC-002. |
| `src/run.ts` | `runLifecycleCommandWorker` verifies database then ledger readiness before marking ready, records only non-idle work, paces idle/released/stale outcomes, and closes every resource in deterministic order. It preserves cleanup errors well. Its catch must distinguish an expected abort from operational failure; LC-001. |
| `test/config.test.ts` | Tests successful cross-package composition and the lease/timeout invariant. It does not cover production OTLP enforcement or individual bounds; include those in the coverage ratchet rather than duplicating every Zod primitive test. |
| `test/run.test.ts` | Tests readiness order, completed and released polling, database/ledger readiness failure, and full cleanup order with useful behavioral fakes. It aborts only after `processNext` resolves, so it misses the confirmed in-flight shutdown defect. |
| `package.json` | Minimal private ESM application with only four direct runtime dependencies and clear build/start/test/typecheck scripts. No unused package abstraction or inappropriate export surface. Keep. |
| `tsconfig.json` | Composite declaration build is narrow to production source and inherits the repository's strict baseline. Keep. |
| `tsconfig.test.json` | Typechecks production, tests, and Vitest configuration without emitting. Keep. |
| `vitest.config.ts` | Correct Node environment and build-output exclusion. It has no coverage policy; LC-002. |

## Test quality and CI

The tests assert orchestration behavior, not implementation trivia. They verify
the readiness order, prevent claims before both authorities are ready, assert
resource shutdown order, and prove cleanup after startup failures. Test files
belong in a separate directory because they use broad testing-only package
types and fakes that must not enter the production build.

The root unit job runs this app's tests, build and typecheck are repository
gates, and lint covers the files. The root selected-source coverage job does
not instrument this app. There is also no executable subprocess test proving
SIGINT/SIGTERM exit codes, readiness-marker cleanup, or bootstrap failure
behavior. LC-002 records that assurance gap.

## Plan and ADR compliance

The application follows the plan's separate lifecycle-command role and process,
dual-region append-only control ledger, fail-closed readiness, bounded polling,
lease/timeout budgeting, telemetry, and graceful-cleanup intent. It correctly
avoids direct table access and provider/business logic. LC-001 is a narrow
contradiction of the graceful-shutdown requirement, not a broader architecture
departure. Database audit DB-003 still applies below this app: ledger I/O can
occur while database locks are held, but that behavior is owned by the database
coordinator rather than duplicated here.

## Evidence-based scorecard

| Area | Score | Reason |
| --- | ---: | --- |
| Correctness | 8.0/10 | Readiness and cleanup are strong; active-operation signal shutdown is misclassified |
| Architecture and boundaries | 9.1/10 | Small composition root using narrow role-specific package interfaces |
| Readability and code craft | 8.9/10 | Clear names, linear lifecycle, precise types, no accidental complexity |
| Reuse and abstraction quality | 9.0/10 | Reuses deep package modules and adds only deployment-specific adapters |
| Security and authority | 9.0/10 | Dedicated database role, strict configuration, sanitized terminal error output |
| Testing and assurance | 7.0/10 | Useful orchestration tests, but no entrypoint/subprocess coverage and only 65.38% full-source branches |
| Operations and observability | 8.0/10 | Ordered cleanup, readiness and metrics are good; expected shutdown can page as fatal |
| Plan and ADR compliance | 8.8/10 | Correct deployment boundary with one graceful-shutdown mismatch |
| **Overall** | **8.5/10** | Professionally small and cohesive, with one concrete lifecycle defect and one test-evidence gap |

## Findings and required improvements

### LC-001 — An expected signal can become a fatal active-operation shutdown

- **Severity/classification:** P2 confirmed correctness/operations defect.
- **Status:** open.
- **Evidence:** `main.ts` aborts with an `Error` for SIGINT/SIGTERM. The
  database coordinator rethrows `signal.reason` when an in-flight claim is
  aborted. `runLifecycleCommandWorker` stores that rejection in
  `operationError` without checking whether it is the expected abort reason,
  then throws `AggregateError`. A focused active-operation probe reproduced
  the fatal aggregate; existing tests abort only after `processNext` resolves.
- **Impact:** normal orchestrator termination during active work reports a
  crash and exit code 1, creating false alerts/restarts and obscuring the
  difference between controlled cancellation and a real processing failure.
- **Required change:** after cleanup, suppress only the exact expected abort
  (`resources.signal.aborted && error === resources.signal.reason`). Preserve
  unrelated errors even if shutdown happens concurrently. Keep release/fence
  behavior in the coordinator authoritative.
- **Verification:** test abort before readiness, during `processNext`, during
  poll delay, and alongside a distinct processing error. Add a subprocess test
  for SIGINT and SIGTERM proving exit 0 and readiness-marker removal while a
  command is active.

### LC-002 — CI does not measure the executable lifecycle surface

- **Severity/classification:** P2 assurance improvement.
- **Status:** open.
- **Evidence:** the app has six passing unit tests, but ad hoc full-source unit
  coverage is 45.33% statements and 65.38% branches. `main.ts` and
  `readiness-marker.ts` are effectively untested, and the repository coverage
  lane does not include this app. The missing in-flight abort branch allowed
  LC-001 to pass all gates.
- **Required change:** add a small application risk cohort covering the runner,
  bootstrap/process lifecycle, and readiness marker. Prefer subprocess tests
  for real signals/exit status and focused dependency injection only where it
  makes bootstrap failure deterministic. Ratchet meaningful branches; do not
  chase generated import lines or arbitrary global percentages.
- **Verification:** CI publishes the app cohort denominator and fails on an
  unreviewed new lifecycle branch; subprocess SIGINT/SIGTERM, startup failure,
  marker creation/removal, and cleanup-failure tests execute in CI.

## Prioritized remediation and completion

1. Fix LC-001 and add its focused runner/subprocess regression tests.
2. Establish the small risk-based coverage ratchet in LC-002.
3. Re-run repository checks and the lifecycle-command audit after any resource
   ownership or signal-handling change.

The audit is complete for the pinned implementation. The application is not
fully remediated until both findings have passing evidence or an explicit,
documented acceptance decision.
