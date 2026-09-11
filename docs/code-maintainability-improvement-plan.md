# Code maintainability improvement plan

Status: **in progress; baseline recorded and M01–M05 complete**.

## Purpose and authority

Make routine changes more local and the existing code easier to explain. This
plan follows the section-by-section review of 2026-09-11. It is a finite follow-up
to the completed readability work, not a declaration that the earlier work is
incomplete and not a campaign to reach a numerical score.

Follow [AGENTS.md](../AGENTS.md), [CONTEXT.md](../CONTEXT.md), current contracts,
and accepted ADRs. The [original readability plan](backend-readability-plan.md),
[implementation ledger](backend-readability-implementation.md), and
[dispositions](backend-readability-dispositions.json) remain historical evidence.
Do not overwrite their inventory or reinterpret retained complexity as a defect.
The backend checkpoint plan still governs backend checkpoint work; this document
does not authorize product features or change production-readiness claims.

This turn authorizes planning documents only. Implementation, commits, and pushes
require subsequent authorization. No architectural decision is introduced here:
the proposed changes preserve public interfaces and deployment/storage ownership.
If implementation would change such a decision, stop for a decision and any
required ADR before proceeding.

## Reviewed baseline

- Branch: `main`, configured upstream `origin/main`; HEAD `c5ad9da5`.
- The working tree already contains the uncommitted readability implementation.
  Preserve it. HEAD alone is not the implementation baseline for this plan.
- The source rescan covers 1,235 code files. Its code-content SHA-256 is
  `57624205fbee224435541c3ac678b560bc96fac98c51bad9e88d67a3ea2ac9a3`.
- Before adding this document, the source fingerprint matched qualification
  `2026-09-11t14-05-30-032z-41515-470b5807`: 21 passing cohorts, 524 passing
  service-suite tests, and three explicitly excluded AWS-only cases.
- That qualification is baseline evidence, not evidence for future edits. Adding
  this document changes the whole-tree fingerprint without changing runtime code.
- Discovery covered every major area; semantic inspection sampled ordinary
  modules, hotspots, and tests. This is not line-by-line certification of all files.

The review's 8.4/10 aggregate is context only. Keep its five criteria and section
weights stable if reassessing: naming, control-flow clarity, module organization,
duplication, and test readability. Completion below is behavioral and concrete;
no target score, line count, or number of helpers is an acceptance criterion.

## Area coverage and disposition

| Area | Planned action | Explicitly retain |
| --- | --- | --- |
| API | Evaluate M06: local feature-registration phases | Feature ownership, authorization, runtime creation/cleanup, connection and webhook policy |
| Worker | Evaluate M07: capacity-sampling locality | Durable publication/settlement, execution ownership, preview/provider distinctions, trigger runtime |
| Lifecycle/operator/recovery/retention apps | No production refactor recommended | Independent bootstrap/error ownership and the existing shared retention loop mechanism |
| Database execution/authoring/triggers | M04 fixture pilot; otherwise retain | Coordinator transaction/query proof, physical-state validation, authoring/trigger contracts |
| Database lifecycle/tenant access/migrations | M02 readiness guard; M04 fixture pilot | Tenant transaction owners, workspace purge, role-specific configuration, append-only SQL |
| Workflow engine/model | Evaluate M08 narrowly | Mutation authority, bounded parsers, expression policy, V1/V2 compatibility |
| Node SDK/catalog/core nodes | M01 bound-resolution invariant | Release history, lifecycle tables, per-node schemas, separate successor policies |
| Public contracts | No dedicated refactor recommended | Explicit client/OpenAPI projections and independent compatibility fixtures |
| Provider integrations | No dedicated refactor recommended | SSRF/DNS/redirect admission, credential lifetime, provider-specific uncertainty |
| Artifact storage/control ledger | M05 private validation phases | Existing resource-owning classes, request budgets, S3 command order, integrity proof |
| Queue | No dedicated refactor recommended | Consumer admission, cancellation, tracing, drain and connection ownership |
| Rate limiting/observability | No dedicated refactor recommended | Declarative policies, stable metric names, bounded cardinality and sanitization |
| Quality/benchmark/exercise tooling | M03 shared test observation mechanics | Production runner ownership, independent measurements/oracles, cohort order |
| Deployment/CI/infrastructure configuration | No dedicated refactor recommended | Declarative manifests, deterministic renderer, external-platform seam |
| Documentation/root/build configuration | Update navigation only if ownership changes | Current source-of-truth hierarchy, build configuration and quality gates |

“Retain” is a reviewed outcome, not unfinished work. Minor naming or literal
inconsistencies may be corrected during related work if behavior and generated
contracts remain identical; they do not justify separate repository-wide sweeps.

## Rollout and priorities

| Wave | Items | Recommendation | Size / risk |
| --- | --- | --- | --- |
| 0 | Capture the current working-tree baseline and relevant tests | Required before implementation | Small / low |
| 1 | M01 SDK binding; M02 readiness guard; M03 test observation helpers | Recommended, independently reviewable | Small each / low |
| 2 | M04 database fixture pilot; M05 artifact validation phases | Worth doing after narrow characterization | Medium each / medium |
| 3 | M06 API composition; M07 capacity sampling; M08 workflow decisions | Conditional: compare retain versus the smallest local change first | Small–medium / medium–high |
| 4 | Final integration, source-bound verification, outcomes | Required for implemented scope | Depends on selected scope |

Start with M01. It has two proven callers of an identical invariant and a small
existing public test surface. M02 and M03 can be separate changes. M04 and M05
can be investigated independently, but serialize service-backed qualification.
M06–M08 are not automatic implementation obligations: record either a justified
local improvement or a justified retained outcome before declaring the plan done.

## M01 — One SDK definition/executor binding invariant

**Owner:** `packages/node-sdk/src/server.ts`, `createNodeRegistry`, specifically
`dispatchMode` and `execute` (currently around lines 417–440).

**Evidence:** both methods resolve an executor, resolve a definition, and repeat
the same binding comparison and error construction. A change to this invariant
currently requires two matching edits.

**Plan:** give the repeated binding comparison and error construction one private,
registry-local owner used by both methods. The two straightforward resolution
calls may stay visible at each caller; do not introduce a per-call result object
solely to combine them. Keep the existing public registry interface.
Do not also replace release lookups with maps or refactor successor validation;
those are separate changes with different costs and compatibility obligations.

**Preserve:** executor-before-definition lookup and first-error order; `execute`
checks cancellation at its existing point; dispatch-aware runtime requirements
remain execution-only; exact errors/messages, ABI selection, normalization,
lookup counts, and allocation behavior remain unchanged. ADR 010 applies.

**Verify:** use `packages/node-sdk/test/registry.test.ts`,
`packages/node-sdk/test/package-contract.test.ts`, and
`packages/node-catalog/test/server-registry.test.ts`. Add only missing public
cases for missing executor, missing definition, mismatched binding, both invalid
identities, cancellation precedence, and matching legacy/dispatch-aware ABI.

**Done:** one private implementation of the invariant, unchanged exported surface,
and both callers pass the same behavioral matrix. Retain the current code if the
change needs a generic compatibility abstraction or eager extra validation.

## M02 — One readiness-option ambiguity check

**Owner:** `packages/database/src/platform/readiness.ts`,
`checkDatabaseReadiness` and `checkDatabaseServingReadiness`.

**Evidence:** both entrypoints reject simultaneous singular and plural expected
compatibility-release options with the same condition and message.

**Plan:** give that exact check one private owner in the same file and call it
at the same point in each entrypoint. Do not combine full startup readiness with
the narrower serving-readiness query. Keep role-specific config parsers in
`config.ts` explicit: similar output fields alone do not justify another mapper.

**Preserve:** ambiguous options reject before any query; support-validation
ordering, SQL, query count, role defaults, and error text are unchanged.

**Verify:** extend `packages/database/test/serving-readiness.test.ts` to exercise
both public entrypoints with conflicting options and a query spy that must remain
unused. Reuse `readiness-probe.test.ts`, `config.test.ts`, and the existing
service-backed readiness coverage for their existing responsibilities.

**Done:** a single ambiguity rule with both fail-before-query cases passing.
No SQL, grants, schemas, runtime roles, or transaction changes belong here.

## M03 — Shared infrastructure test observation mechanics

**Owners:** `infrastructure/run-local-quality.test.mjs` and
`infrastructure/performance/run-local-benchmark.test.mjs`.

**Evidence:** both contain identical `waitForFile` and `processExists` functions.
They encode the same filesystem/process observation and error policy, unlike
the deliberately independent measurement calculations in those suites.

**Plan:** move only those mechanics into one test-only infrastructure support
module consumed by these two suites. Keep scenario creation, process ownership,
signals, failure injection, assertions, expected values and teardown at the
current test sites. No production imports of test support.

**Preserve:** five-second default deadline, 25 ms polling, UTF-8 file contents,
retry only on `ENOENT`, missing PID only on `ESRCH`, and propagation of other
errors. Do not add process termination or ownership to the observation helper.

**Verify:** run both existing Node test files. Add focused support tests only
where an error-policy branch is not already exercised; keep subprocess tests as
real subprocesses. Check dependency analysis recognizes the helper as test-only.

**Done:** exactly two shared observation mechanics with unchanged scenarios and
no global test harness. Stop if generalization needs callback/mode options.

## M04 — Two-suite database fixture pilot

**Owners:** existing database test support and these initial consumers only:

- `packages/database/test/artifact-finalization-retention-deadline-migration.integration.test.ts`;
- `packages/database/test/artifact-media-type-http-safety-migration.integration.test.ts`.

**Evidence:** both already use `createDisposableDatabaseFixture` with the same
seven connect roles. They repeat an identical migration configuration and
filename-filter/copy operation for constructing a prior-head directory. This
pair avoids changing database lifetime or role policy just to remove duplication.

**Plan:** keep `test/support/disposable-database.ts` unchanged. Use one test-only
owner for the identical migration configuration, parameterized by connection
string. A second small helper may own the exact migration filename filtering
and copying if it makes both callers clearer. Keep directory acquisition and
release, database names, seven-role grant arrays, explicit `0083_`/`0085_`
cutoffs, expected prior heads, seed SQL, tenant/owner transactions, historical
fixtures, and failure expectations scenario-local. Do not migrate every test or
introduce a universal transaction helper.

**Preserve:** exact configuration fields and role values, database identity,
filename regex, exclusive cutoff and parallel copying, admin pool bounds,
release order, disconnected-drop behavior, and current primary/cleanup failure
semantics. Do not add sorting or other behavior absent from the current copy
operation. Do not replace PostgreSQL or rewrite historical migrations.

**Verify:** run both suites against isolated PostgreSQL with their existing
integration configuration, followed by database typecheck and database integration
qualification. Confirm test counts are nonzero and cases are not skipped.

**Done:** the two suites visibly contain their scenarios rather than repeated
migration mechanics, with unchanged historical and role-specific assertions.
Any rollout beyond these two files requires a separately named finite cohort.
If reuse requires role-specific branches, force-drop options or injected cleanup
callbacks, retain that consumer rather than generalizing the fixture.

## M05 — Name artifact validation phases without moving IO ownership

**Owners:** `packages/artifact-store/src/store.ts`,
`AwsArtifactStore.purgeWorkspacePage`; and `src/control-ledger.ts`,
`AwsControlLedger.reconcile`. Treat the two methods as separate reviewable slices.

**Evidence:** purge mixes listing admission, entry identity checks, deletion and
acknowledgement validation. Reconciliation mixes anchor admission, listing/key
continuity checks, bounded reads, hash-chain advancement and a final probe.

**Plan:** begin with private, domain-specific validation phases. Keep the visible
sequence of S3 calls and their resource owner in each public method. Reuse the
current arrays/sets instead of materializing extra intermediate collections.
Do not create a generic S3 paginator, validator framework, or new storage adapter.

**Preserve:** malformed/oversized/wrong-workspace listings fail before deletion;
delete failure and acknowledgement mismatch remain distinct; invalid anchor
fails before listing; malformed listing fails before reads; missing records,
hash-chain failures and probe failures keep their precedence. Preserve request
budgets, concurrency, cancellation, readiness, cardinality and all error shapes.
ADRs 013 and 015 remain binding; storage/ledger policy is not being redesigned.

**Verify before extraction:** characterize command order/count and no-later-IO
on failures through existing public adapter tests. Reuse `store.test.ts`,
`control-ledger.test.ts`, `control-ledger-part-2.test.ts`, and both dual-region
test files. Run the package coverage suite and selected real-service integration
cohorts. Local emulation does not replace the three documented AWS-only cases.

**Done:** the destructive and integrity phases are identifiable from the public
method, with unchanged command sequence, bounds, error behavior and allocations.
Retain any phase whose extraction adds more parameters/state tracking than it
removes. No client or lifecycle ownership moves.

## M06 — Conditional API composition simplification

**Owner:** `apps/api/src/app.module.ts`, `AppModule.register`.
Read `apps/api/src/app.ts` as a contract consumer/owner; do not move its runtime
creation, validation or cleanup into module-registration helpers.

**Candidate:** private same-file feature-registration/readiness phases could
replace nested conditional spreads. Compare this with retaining the current code
before editing. Do not build a runtime descriptor registry or new public seam.

**Preserve:** identity-gated features, supported override/config combinations,
module/provider order and identity, route availability, additive readiness,
exactly-once shutdown, and HTTP/worker role separation (ADR 001).

**Verify:** inspect existing `api-bootstrap.test.ts` cases first; add only missing
representative supported optional-runtime combinations, not a full power set.
Run that suite plus `feature-import-boundaries.test.ts`,
`orchestration-coverage-config.test.ts`, and API typecheck/coverage.

**Proceed only if:** optional feature registration becomes easier to trace without
another configuration representation or changes to dependency ownership. A
documented retain decision satisfies this item if that benefit is not demonstrated.

## M07 — Conditional worker capacity-sampling locality

**Owner:** `apps/worker/src/transport/outbox-dispatcher.ts`, capacity-sampling
maps/set/promise and their scheduling/draining methods.

**Candidate:** an internal same-file owner for the bounded sampling state may
separate it from durable claim/publish/settle logic. Keep dispatcher lifecycle
authority and queue/backlog observation unchanged. Compare against retaining the
current private methods; do not design a generic observer framework.

**Preserve:** scheduling only after successful marking for the currently selected
job kinds (`advanceWorkflowRun` and `expireArtifacts`); non-blocking publication;
per-workspace interval, pending/tracked limits and eviction order; runtime-hook
configuration rules; existing close behavior and operation deadlines. Telemetry
must never change durable outcomes. ADRs 005 and 030 apply.

**Verify:** through `apps/worker/test/outbox-dispatcher.test.ts`, characterize
duplicate-workspace coalescing, limits/eviction, failure swallowing, and close
with a sample in flight before moving state. Use controlled promises/timers.
Run worker typecheck, coverage and applicable transport/resilience qualification.

**Proceed only if:** sampling state and its lifecycle can be understood in one
place without new callbacks exposing dispatcher internals or new timers. Otherwise
retain; do not trade visible ownership for fewer lines.

## M08 — Conditional workflow decision locality

**Owner:** `packages/workflow-engine/src/workflow-transition-observations.ts`,
`applyLoopCompletion` and `applyInvocationObservation`.

**Candidate:** name only a concrete repeated or interleaved decision, such as
terminal replay recognition. Keep mutation and event drafting at their existing
ordered points. Do not split observation kinds into files or add a state-machine
framework. The existing `sameOutputReference` remains authoritative.

**Preserve:** identical versus divergent terminal replay, cancellation/deadline
precedence, transition-validation timing, loop terminal cause, output identity,
event ordering and suppression, `externalFactsArePersisted`, and
`coordinatorDerived` behavior. Bounded grammar/security and compatibility owners
remain intact.

**Verify:** use `workflow-transition-risk-behavior.test.ts`,
`advance-workflow-transitions.test.ts`, `transition-policy-mutation.test.ts`,
`checkpoint-seam.test.ts`, and both executable foreach suites. Add only absent
replay/event-order characterizations at the public transition interface.

**Proceed only if:** a named decision reduces mental execution while preserving
state ownership and first failure. Otherwise record retain. Do not extract a
helper whose interface merely restates its implementation.

## Verification and completion protocol

For each implemented item:

1. Inspect the current diff and preserve unrelated work. Capture a reproducible
   working-tree/source fingerprint before editing, not just the HEAD SHA.
2. Resolve the named symbols/test files against current source. Record existing
   tests before adding overlapping coverage. Add any required behavioral
   characterization before restructuring the affected code.
3. Run the owning focused tests and typecheck. Test public behavior, not every
   private helper. Preserve real integration seams and independent expected values.
4. Compare exported interfaces, errors, command/query order, resource ownership,
   bounds and copies. Inspect the diff manually; passing gates alone is not proof
   of improved locality.
5. If a covered source module is split, carry its coverage inclusion and stronger
   threshold group to every extracted file. Do not lower thresholds, widen
   exclusions, add complexity exemptions, or regenerate golden history to pass.
6. Record the actual outcome below: implemented with evidence, or retained with
   a concrete reason. A failed/unrun required check is pending, not complete.

Representative focused commands (run from the repository root):

```sh
pnpm --filter @pertexo/node-sdk test
pnpm --filter @pertexo/node-catalog exec vitest run test/server-registry.test.ts
pnpm --filter @pertexo/database exec vitest run test/serving-readiness.test.ts test/readiness-probe.test.ts test/config.test.ts
node --test infrastructure/run-local-quality.test.mjs infrastructure/performance/run-local-benchmark.test.mjs
pnpm --filter @pertexo/artifact-store test
pnpm --filter @pertexo/api exec vitest run test/api-bootstrap.test.ts test/feature-import-boundaries.test.ts test/orchestration-coverage-config.test.ts
pnpm --filter @pertexo/worker exec vitest run test/outbox-dispatcher.test.ts
```

The M04 tests need isolated PostgreSQL, not an unconfigured unit-test invocation.
Use the existing [local qualification runbook](operations/local-quality-verification.md)
and its database cohort; do not invent credentials or point destructive fixtures
at a shared database. Its supported partial run is
`pnpm quality:local -- --partial integration-database`.

After all selected implementation work, run fresh `pnpm check` and
`pnpm quality:local`, plus owning coverage suites where not already included.
Verify successful tests actually executed, source stability, manifests and named
external exclusions. Check `git diff --check`, final status, and relevant diffs.
Do not reuse the baseline qualification as final evidence for changed source.

No score uplift is promised. Success means the named duplication or navigation
problem is demonstrably reduced with unchanged behavior. Do not expand the scope
when a slice finishes; reassess conditional items explicitly and stop after the
selected work and final verification are complete.

## Outcome checklist

- [x] Working-tree baseline and intended implementation scope recorded.
- [x] M01 completed with binding/error-order evidence.
- [x] M02 completed with fail-before-query evidence.
- [x] M03 completed with unchanged subprocess/error-policy evidence.
- [x] M04 two-suite pilot completed, or non-equivalent consumer retained with reason.
- [x] M05 purge and reconciliation slices completed or individually retained with reason.
- [x] M06 local comparison recorded; implemented and verified, or retained.
- [x] M07 local comparison recorded; implemented and verified, or retained.
- [x] M08 local comparison recorded; implemented and verified, or retained.
- [ ] Final source-bound checks, coverage inheritance, and outcomes recorded.

Implementation and commits are authorized for the current request; pushing is
not. Use coherent independently verified changes and the repository's git
discipline, never a fixed commit count or history rewrite.

## Implementation outcomes

- **Baseline:** the reviewed readability tree was committed as seven coherent
  changes from `d7ccc492` through `db0a6ee7`. Qualification
  `2026-09-11t15-12-34-120z-87347-7e1fb885` passed all 21 cohorts against
  working-tree fingerprint
  `21daac2ad60d90381db8456e12d2bd2c56cfe7a3a1520f629062f2ad036f2744`.
- **M01 — implemented:** `createNodeRegistry` now uses one package-internal binding
  invariant used by `dispatchMode` and `execute`. The public matrix covers
  executor-before-definition failure order, definition failure, exact binding
  failure text, cancellation precedence, and matching ABI 1/ABI 2 behavior.
  The two node-sdk tests passed with 39 cases, the node-catalog server-registry
  suite passed with 4 cases, and node-sdk typecheck passed.
- **M02 — implemented:** both readiness entrypoints now call one same-file
  ambiguity guard before support validation or SQL. A parameterized public test
  proves both paths retain the exact error and make zero query calls. The focused
  serving-readiness, readiness-probe, and config suites passed with 18 cases, and
  database typecheck passed.
- **M03 — implemented:** the two infrastructure suites now import only
  `waitForFile` and `processExists` from one test-only module. Focused support
  cases pin propagation of non-`ENOENT` filesystem errors and non-`ESRCH`
  process errors; the real subprocess suites remain unchanged at their call
  sites. All 55 owning Node tests, architecture/dependency checks, and focused
  lint passed.
- **M04 — implemented:** the two artifact migration suites share one test-only
  owner for their identical seven-role migration configuration and unsorted,
  parallel prior-head copy mechanics. Database names, seven-role fixture grants,
  directory lifetime, explicit `0083_`/`0085_` cutoffs, SQL, and assertions remain
  scenario-local. Partial qualification
  `2026-09-11t15-33-54-639z-19311-0b4e3007` was source-stable and passed all 418
  database integration cases; its JSON report confirms both named cases executed
  and passed. The 297 database coverage cases and merged thresholds also passed.
- **M05 — implemented:** package-internal modules now name workspace-purge listing admission, entry
  identity construction, and delete-acknowledgement validation around the same
  list/delete calls and existing sets. Reconciliation names empty/anchor,
  listing/key-continuity, and final-probe validation around the same anchor,
  list, bounded-read, hash-advance, and probe sequence. The ordered read and
  hash-advance loops remain local because extracting them would add a state
  carrier or restate their parameters. Added public assertions pin list/delete
  order, distinct delete failure, invalid-anchor/list no-later-I/O, and the
  existing bounded read count. The 157 focused tests, typecheck, and all 221
  coverage cases passed. Source-stable partial qualification
  `2026-09-11t15-46-39-986z-25943-c01bef9e` passed 5 local service cases and
  retained the three named AWS-only exclusions.
- **M06 — retained:** `AppModule.register` keeps the feature imports as one
  identity-gated, visibly ordered array. A same-file phase would need another
  argument/configuration representation while separating module order from the
  constructors that establish it; it would not make authorization or runtime
  ownership easier to trace. The existing representative combinations cover
  identity-only discovery and workflow, webhook, schedule, and artifact
  composition, readiness, and cleanup. The three focused suites passed 37 cases,
  API typecheck passed, and all three API coverage configurations passed 626
  cases without changing the module.
- **M07 — retained:** the three capacity-sampling fields and three adjacent
  private methods already keep bounded sampling state in one place. Extracting
  them would require callbacks for the runtime hook, timeout, and dispatcher
  lifecycle, or would move lifecycle authority away from the dispatcher.
  Public tests now additionally prove the 100-pending limit, 1,000-entry
  oldest-first tracking eviction, and that close drains an in-flight sample
  before closing the database and producer. The focused suite passed 25 cases,
  worker typecheck and all 323 coverage cases passed, and source-stable partial
  qualification `2026-09-11t15-52-21-461z-27252-866e355d` passed the real Redis
  and PostgreSQL worker-transport resilience cohort.
- **M08 — retained:** both terminal-replay branches keep the authoritative
  `sameOutputReference` comparison directly beside their distinct transition
  and mutation rules. A helper would take the existing and observed
  status/output fields only to restate the same predicate, without reducing the
  ordered mutation work in either function. A new public characterization proves
  an output-identical terminal invocation replay is event-free and a divergent
  output fails with `transition_invalid`; the loop replay coverage remains in
  place. The six focused suites passed 89 cases, workflow-engine typecheck
  passed, and all 307 coverage cases passed.
