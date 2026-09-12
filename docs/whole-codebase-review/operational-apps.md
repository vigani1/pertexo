# Operational applications: file-by-file review

Scope: all 46 inventoried files in `apps/lifecycle-command`,
`apps/operator-command`, `apps/recovery`, and `apps/retention`. All source,
tests, process fixtures and configuration were read in full. Paths below are
repository-relative. Judgments use J01–J14 in the main plan. No application
source or tests were changed by this review.

## File ledger

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/lifecycle-command/package.json` | KEEP; existing PF-03 | Correct ESM/compiler/runtime commands and direct workspace dependencies. Retain separate coverage command; PF-03 owns any additional entrypoint gate. |
| `apps/lifecycle-command/src/config.ts` | KEEP | Explicit bounded durations, production export requirement and the four-statement-plus-external lease budget communicate real coordination constraints. Do not collapse these into a generic environment parser. |
| `apps/lifecycle-command/src/main.ts` | FIX: existing PF-02/PF-03 | App-owned injectable bootstrap is useful. Metrics construction occurs after the ownership flag; failure logging can bypass pre-handoff cleanup. Existing structural plan already specifies the corrections; this pass reproduced the former again. |
| `apps/lifecycle-command/src/readiness-marker.ts` | KEEP | Two-method file-backed marker is appropriately small. Clear-before-readiness and clear-during-shutdown belong to the runner; configurable path makes real filesystem tests possible. |
| `apps/lifecycle-command/src/run.ts` | KEEP | Ordered readiness, explicit idle/released/stale polling and exact abort-reason discrimination are clear. Deferred close callbacks catch synchronous throws and continue through all owners. Preserve this cleanup shape. |
| `apps/lifecycle-command/test/config.test.ts` | KEEP | Tests actual configuration composition, lease-budget rejection and both production telemetry branches; synthetic credentials only. |
| `apps/lifecycle-command/test/coverage-config.test.ts` | KEEP | Locks the four-file executable cohort without claiming that inclusion alone proves behavioral coverage. |
| `apps/lifecycle-command/test/lifecycle-command-process.fixture.mjs` | TEST: existing PF-03 | Exercises compiled real bootstrap/runner/marker with fake adapters and a deliberately owned keepalive. PF-03 adds metrics-construction failure without copying bootstrap logic. |
| `apps/lifecycle-command/test/main.test.ts` | TEST: PF-03; REFACTOR: WQ-049 | Good acquisition, invoked-owner and dynamic-import checks. Add existing PF-03 fault matrix; restore stubbed environment in unconditional teardown, not only after a successful assertion. |
| `apps/lifecycle-command/test/process-lifecycle.test.ts` | KEEP; TEST: PF-03 | Bounded startup/exit waits, post-subscription checks, force-kill teardown and isolated marker directories are justified test lifecycle code. Actual-entrypoint failure is distinguished from fixture-handled construction failure. |
| `apps/lifecycle-command/test/readiness-marker.test.ts` | KEEP | Real permission and idempotent cleanup checks; teardown restricted to created temporary directories. |
| `apps/lifecycle-command/test/run.test.ts` | KEEP | Tests expected versus distinct aborts, readiness gating and every cleanup error. The result guards and explicit event order make ownership readable. |
| `apps/lifecycle-command/tsconfig.json` | KEEP | Composite source build references the three actual runtime packages and keeps declarations/output isolated. |
| `apps/lifecycle-command/tsconfig.test.json` | KEEP | Includes source, tests and both Vitest configs with no emitted test output. |
| `apps/lifecycle-command/vitest.config.ts` | KEEP | Minimal Node test configuration excludes compiled/dependency directories. |
| `apps/lifecycle-command/vitest.coverage.config.ts` | KEEP | Explicit risk cohort, output directory and thresholds; comment correctly excludes child-process counters from unit coverage claims. |
| `apps/operator-command/package.json` | KEEP; existing PF-03 | Direct database/observability/Zod dependencies and ESM compiled start are appropriate. Main/process evidence belongs to PF-03. |
| `apps/operator-command/src/config.ts` | REFACTOR: WQ-050; TEST: WQ-049 | Discriminated command schemas correctly require command-specific fields and explicit dry-run where supported. Replace the nested mapping IIFE/repeated audit fields with one private named mapper; keep explicit variants and conversion rules. |
| `apps/operator-command/src/main.ts` | FIX: existing PF-02/PF-03 | Preserve telemetry-before-import and command-owned cleanup. Guard diagnostics, construct arguments before ownership transfer and add import-safe bootstrap/process seam as already planned. |
| `apps/operator-command/src/run.ts` | FIX: existing PF-02 | Command switch is clear and must remain exhaustive. Bounded cleanup callbacks already handle synchronous throws; unguarded failure logger can prevent reaching them. PF-02 owns this defect. |
| `apps/operator-command/test/config.test.ts` | TEST: WQ-049/WQ-050 | Existing seven cases check several positive mappings, but the broad “implicit or unbounded” case omits nearly everything and does not isolate individual bounds or dry-run requirements. |
| `apps/operator-command/test/run.test.ts` | KEEP; TEST: PF-02 | Table covers every command dispatch and verifies nonselected methods remain unused. Null status, undefined rejection, bounded cleanup and aggregate ordering are meaningful. Add throwing-diagnostics regression from PF-02. |
| `apps/operator-command/tsconfig.json` | KEEP | Source-only composite output and database/observability references match imports. |
| `apps/operator-command/tsconfig.test.json` | KEEP | No-emit source/test/config typecheck is separate from production output. |
| `apps/operator-command/vitest.config.ts` | KEEP | No unnecessary mocking or global environment state in runner configuration. |
| `apps/recovery/package.json` | KEEP; existing PF-03 | Correct three workspace dependencies plus Zod; compiled command is distinct from the API serving process. |
| `apps/recovery/src/config.ts` | KEEP; TEST: WQ-049 | Page/record capacity guards and cross-region artifact/ledger principal/bucket separation are explicit and useful. Add targeted negative evidence rather than replacing these guards with opaque helpers. |
| `apps/recovery/src/main.ts` | FIX: existing PF-02/PF-03 | Metrics-after-handoff and diagnostics-before-cleanup faults already have an implementation owner. Preserve restoration timeout, signal cleanup and recovery-owned finalization. |
| `apps/recovery/src/restore-before-serve.ts` | FIX: PF-02; TEST: WQ-048 | Readiness/reconciliation/inventory phases and tuple digest are coherent. Failure metric/logger can skip cleanup; existing PF-02 owns that correction. Pagination behavior needs exact multi-page proof. |
| `apps/recovery/test/config.test.ts` | TEST: WQ-049 | Defaults, aggregate page capacity and duplicate region are tested; production export, page-size-over-record-limit and cross-kind credential/bucket combinations are not. |
| `apps/recovery/test/restore-before-serve.test.ts` | TEST: PF-02/WQ-048 | Good readiness ordering, cancellation, undefined rejection and cleanup-failure cases. Single-artifact success does not prove cursor forwarding or digest content. |
| `apps/recovery/tsconfig.json` | KEEP | Composite source build and three runtime package references match app ownership. |
| `apps/recovery/tsconfig.test.json` | KEEP | Includes local test/config sources without changing compiler architecture. |
| `apps/recovery/vitest.config.ts` | KEEP | Minimal Node runtime and generated-directory exclusions are sufficient. |
| `apps/retention/package.json` | KEEP; existing PF-03 | Declares actual OpenTelemetry API dependency and maintenance-related workspace packages. Keep build/start unchanged. |
| `apps/retention/src/config.ts` | KEEP; TEST: WQ-049 | Lease/time budgets, replica sampling bounds and all-pair artifact/ledger separation are readable domain validation. Lease adequacy across SQL phases remains part of the database review, not inferred solely from config arithmetic. |
| `apps/retention/src/main.ts` | FIX: existing PF-01/PF-02/PF-03 | Partial acquisition cleanup, failure diagnostics and metrics-before-handoff are already planned. Shared `databaseRuntime` is explicitly owned once; do not introduce per-coordinator pools. |
| `apps/retention/src/maintenance-loops.ts` | FIX: WQ-046/WQ-047 | Separate operation loops, one shared readiness gate per dependency and capped failure backoff are justified. Outer `Promise.all` does not drain siblings after rejection; unguarded comparison with an un-aborted signal's undefined reason can silently end one loop. |
| `apps/retention/src/metrics.ts` | KEEP; TEST: WQ-049 | Instrument names, seconds conversion and bounded mode/outcome labels are explicit. Preserve public metric vocabulary; test the currently unasserted branches and numeric observations. |
| `apps/retention/src/run.ts` | FIX: WQ-046/WQ-047 | Existing ordered cleanup loop is sound, but awaiting the already-rejected maintenance aggregate does not await its individual children. Replica monitor has the same undefined-reason discrimination gap. |
| `apps/retention/test/config.test.ts` | TEST: WQ-049 | Tests defaults, page limit, lease equality and one principal collision. Expand production telemetry and cross-region/cross-kind separation cases without asserting vendor-specific deployment qualification. |
| `apps/retention/test/metrics.test.ts` | TEST/REFACTOR: WQ-049 | One combined case covers failure/purge/unknown rerun and lag conversion, not the other recorder branches. Separate named metric scenarios with shared instrument setup. |
| `apps/retention/test/run.test.ts` | TEST/REFACTOR: WQ-046/WQ-047/WQ-049 | Useful public outcome/poll matrix and failure-isolation tests. Twenty arbitrary microtask turns are a brittle synchronization contract; duration test changes a clock but only asserts `expect.any(Number)`. Add observable barriers and actual duration checks. |
| `apps/retention/tsconfig.json` | KEEP | References the shared runtime packages and retains source-only declarations/build output. |
| `apps/retention/tsconfig.test.json` | KEEP | Correctly typechecks application/test/config files without emitting them. |
| `apps/retention/vitest.config.ts` | KEEP | Intentionally small Node test configuration; no framework migration needed. |

## Existing findings confirmed, not duplicated

PF-01–PF-03 in [the structural plan](../structural-follow-up-plan.md) already
cover partial-bootstrap cleanup, safe diagnostics, argument construction before
ownership transfer and real main/process tests. Local current-source probes in
this pass confirmed:

- Recovery readiness rejection plus a throwing error logger returned the
  diagnostic error and recorded `closed: []` across coordinator, ledger,
  artifacts and telemetry.
- Lifecycle bootstrap with a throwing metrics factory recorded
  `invoked: false, closed: []` after coordinator/ledger acquisition.

These are controlled fault-injection results, not reported production incidents.
No new WQ identifiers are assigned to them. WQ-046 below revises only the prior
KEEP judgment of retention's **supervisor drain**, not its already-correct
deferred resource cleanup loop or PF-01's bootstrap ownership.

## WQ-046 — await every started maintenance child before resource cleanup

**P2, FIX; J01/J07/J12.**

Locations: `apps/retention/src/maintenance-loops.ts`, `runMaintenanceLoops`
(lines 346–371), and `apps/retention/src/run.ts`, supervisor creation/join
(lines 45–77). The current structure is:

```ts
// runMaintenanceLoops
await Promise.all([loopA(), loopB(), /* six more started loops */]);

// runRetentionWorker
await Promise.all(supervisors);
// after the first rejection:
supervisorShutdown.abort(stopReason);
await Promise.allSettled(supervisors);
// close resources
```

The second join sees a rejected maintenance aggregate, not its still-running
children. Example: one operation fails and its diagnostic callback also throws,
while another operation is awaiting a deferred database result. A public runner
probe logged all eight fixture close effects and `worker-rejected` **before**
the deferred sibling's `slow-settled`. An abort request did not settle that work.
This proves an ownership ordering defect; it does not establish data loss or a
production database call continuing successfully after closure.

Implementation shape: give the maintenance-loop group ownership of all eight
child promises and a local stop signal. On a fatal child rejection, capture the
first failure with a separate boolean (undefined is a possible rejection), abort
siblings, then await **all child settlements** before returning/rejecting. The
top-level runner continues owning replica-monitor coordination and closes only
after both supervisors are truly drained. Alternatively expose one app-private
group join with these same semantics; do not add a cross-repository supervisor
framework or merely replace the existing `Promise.all` with a potentially
never-finishing `allSettled` that never signals siblings to stop.

Preserve independent retry/backoff for ordinary recoverable operation errors,
database-only work during external readiness failure, readiness single-flight,
the public outcome-to-poll matrix, first initiating error and cleanup ordering.
Do not resolve a timeout race and call that evidence of drained underlying work.
If a drain deadline is introduced, it needs an explicit owner/failure policy;
do not silently detach maintenance that can touch shared resources.

Regression work in `apps/retention/test/run.test.ts`:

1. Hold a sibling operation on a deferred promise; fault another loop's
   diagnostic path. Observe sibling abort, zero resource closes and an unsettled
   worker until the held operation settles; then assert every close once.
2. Repeat with delayed artifact/ledger readiness and an active artifact or
   purge operation. Release every test-owned deferred in teardown.
3. Fail the replica monitor fatally while maintenance is active; verify the
   same drain barrier. Distinguish first fatal error, expected abort and cleanup
   errors; no unhandled rejections.
4. Keep existing failure-isolation and normal abort/backoff tests passing.

Order: implement with WQ-047, then run all retention tests/typecheck. It is
independent of PF-01 pre-handoff cleanup but must be integrated into the PF-03
compiled worker shutdown evidence.

## WQ-047 — require an aborted signal before treating its reason as cancellation

**P2, FIX; J01/J03/J08/J12.**

Locations: `runOperationLoop` in `apps/retention/src/maintenance-loops.ts:125`
and `monitorRegionalReplicaLag` in `apps/retention/src/run.ts:122`.

```ts
// Current: an un-aborted signal also has reason === undefined.
if (error === signal.reason) return;

// Required discrimination:
if (signal.aborted && error === signal.reason) return;
```

An adapter rejection of `undefined` silently terminates the individual loop
without failure metrics, reporting or retry. The other loops keep the process
alive, so this is not an obvious process crash. Current-source maintenance
probe: `signalAborted: false, calls: 1, failures: 0`; the overall group later
resolved after deliberately aborting the remaining fixture loops. The replica
monitor uses the identical condition; its behavior still needs its own focused
regression rather than claiming that the first probe executed both paths.

Use the explicit guard already present in lifecycle's runner. Do not replace it
with “ignore all errors whenever aborted”: a distinct error concurrent with
shutdown must still follow the failure policy. Add undefined rejection to each
loop/monitor test, assert recorded failure and retry before shutdown, and test
actual matching abort plus a distinct error after abort. This is a failure-path
contract fix, not a claim that PostgreSQL normally rejects with undefined.

## WQ-048 — prove the restore artifact inventory, not only one-item success

**P2, TEST; J01/J10/J12.**

Locations: `verifyArtifactInventory` in
`apps/recovery/src/restore-before-serve.ts:68` and
`apps/recovery/test/restore-before-serve.test.ts:180` onward.

Keep production paging logic unless tests expose a defect. Add a small ordered
two-workspace, multiple-artifact fixture spanning pages. Assert exact
`afterWorkspaceId`/`afterArtifactId`, configured limit and signal on each query;
assert each replica check exactly once and in returned order. Calculate the
expected SHA-256 from independently specified tuple bytes, including NUL field
separators, byte length and newline record terminator. Assert digest, total count
and page count, not just `expect.any(String)`.

Add empty complete inventory (known empty SHA-256), `hasMore: true` with no
artifacts, page-bound exhaustion, and failure/abort between pages. None may log
completion on failure; all acquired owners still close under PF-02. Cursor
monotonicity and SQL ordering are the database selector's contract; do not add
redundant application sorting or silently deduplicate database rows here.

Acceptance: new cases pass through the exported `restoreBeforeServe` operation
and preserve the existing aggregate error contract. No real buckets or restored
database are necessary for this unit evidence.

## WQ-049 — strengthen operational test claims and remove brittle setup

**P2, TEST/REFACTOR; J02/J04/J12.**

Make the following independently reviewable test changes; no blanket rewrite of
working fixtures or cross-app test-helper package is warranted.

| File/location | Concrete change and acceptance |
| --- | --- |
| `apps/retention/test/run.test.ts`, `flushMaintenancePromises` and outcome matrix | Replace the fixed twenty microtask turns with controlled “iteration entered/result observed” barriers or bounded polling of an actual call condition. Test failure should identify the missing event, not depend on implementation promise depth. Ensure fake timers and every pending fixture are released in `finally`. |
| Same file, “measures every independently supervised poll operation” | The simulated clock is advanced but every duration assertion accepts any number. Give each independently awaited operation an explicit start/finish barrier and assert its own duration, excluding sibling work as promised by the metric description. A constant zero, shared whole-loop elapsed time or swapped units must fail the test. |
| `apps/retention/test/metrics.test.ts` | Extract only local instrument setup; split failure, replica lag, purge and rerun cases. Add open/paused/unavailable with null lag, known/unknown/null rerun, schedule idle/scheduled, transient rows per class, idle/non-idle batch rows/pages, preview and run-artifact branches. Assert exact units, values and absence of workspace/run IDs in attributes. |
| `apps/lifecycle-command/test/main.test.ts`, production-default environment case | Put `vi.unstubAllEnvs()` in `afterEach` or `finally` so an assertion failure cannot leak environment overrides into subsequent tests. Preserve existing dynamic-import and ownership tests. |
| `apps/operator-command/test/config.test.ts` | Start each negative case from one valid complete environment; vary one field at a time. Cover missing/invalid explicit dry-run, timeout endpoints, actor/reason bounds, bad UUID, evidence JSON object restriction, malformed/over-limit replay input, production telemetry, and currently omitted command mappings. Do not use a largely empty object as proof of every bound. |
| `apps/recovery/test/config.test.ts` | Add production export absent/present, ledger page size above record bound, exact valid capacity, and all primary/recovery artifact-versus-ledger bucket/principal collision pairings. Each rejection must identify the intended guard. |
| `apps/retention/test/config.test.ts` | Add production export absent/present and equivalent all-pair bucket/principal isolation cases; retain exact lease-equality and page-limit regressions. |

Keep local explicit outcome tables where they expose differing domain decisions;
do not generate expectations from the production predicate under test. Missing
tests here are not themselves assertions that configuration validation is broken.
Acceptance: relevant app tests and typechecks pass, and the listed wrong-value or
wrong-order changes would cause a named regression to fail.

## WQ-050 — name operator command translation and centralize only audit fields

**P3, REFACTOR; J02/J04/J05.**

Location: `apps/operator-command/src/config.ts:224–330`, command-mapping IIFE
inside the final configuration object. The ten command cases repeat actor,
command ID, reason and workspace assignments while mixing translation with
database/observability composition. These are one stable audit identity, not
ten independent policies.

Extract a private `toOperatorCommand(parsed)` using the inferred environment
schema output. Inside it, construct one `auditIdentity` value and keep the
existing exhaustive switch with explicit command-specific mappings:

```ts
const auditIdentity = {
  actorRef: parsed.OPERATOR_ACTOR_REF,
  commandId: parsed.OPERATOR_COMMAND_ID,
  reason: parsed.OPERATOR_REASON,
  workspaceId: parsed.OPERATOR_WORKSPACE_ID,
};
switch (parsed.OPERATOR_COMMAND_TYPE) {
  case 'operator.status':
    return Object.freeze({ ...auditIdentity, type: parsed.OPERATOR_COMMAND_TYPE });
  // Other cases retain explicit dryRun, target and source-run conversions.
}
```

The top-level configuration then reads `command: toOperatorCommand(parsed)`.
Keep the explicit public command union, schema validation, absent `dryRun` for
status/evidence, replay `sourceRunId` mapping, maintenance target-type literals,
frozen command objects and bounded input. Do not replace the switch with a
string-indexed callback registry or unchecked cast.

Do WQ-049's full command mapping cases first and verify exact equality for every
variant before/after. This is a small private readability refactor, not a new
module/interface or an architectural decision requiring an ADR.

## Verification performed

- `pnpm --filter @pertexo/recovery --filter @pertexo/operator-command --filter
  @pertexo/retention test`: recovery 11 tests / 2 files; operator 24 / 2;
  retention 49 / 3; all passed.
- `pnpm --filter @pertexo/lifecycle-command build`, then `test`: build passed;
  25 tests / 6 files passed, including the compiled child-process cases.
- Local source probes reproduced the two previously planned ownership faults,
  WQ-046's premature resource-close ordering and WQ-047's silent loop exit.
- Dependencies were the checkout's existing compiled workspace packages; the
  four source probes imported the audited app modules directly. This is not a
  full fresh workspace build, deployed recovery exercise or IAM qualification.

Implementation order: WQ-046/WQ-047 together as supervisor correctness;
PF-01–PF-03 at their existing owners; WQ-048 and WQ-049 as focused regression
units; WQ-050 after its mapping tests. Source stability and exact ledger coverage
are checked against the frozen inventory separately.
