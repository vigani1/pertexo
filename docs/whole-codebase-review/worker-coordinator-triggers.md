# Worker coordinator, trigger and compatibility review

Date: 2026-09-12. Primary reviewer fully read 19 inventory files. Eight safe
unit files / 25 tests passed. Coordinator runtime test file was inspected but
not executed in this pass: some cases leave production database/Redis adapters
enabled. Runtime probes injected every dependency and contacted no service.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/worker/src/execution/coordinator-engine.ts` | KEEP; TEST WQ-103 | Exact persisted projection verification precedes real engine advancement. Four no-change conditions and revision-normalized deep comparison protect meaningful state, not arbitrary nested branching. |
| `apps/worker/src/execution/coordinator-handler.ts` | KEEP; TEST WQ-103 | Linear load/identity/verify/advance/ack-or-commit phases are readable. No-op acknowledgement avoids revision churn. Metrics and notification failures are deliberately contained after commit. |
| `apps/worker/src/execution/coordinator-runtime.ts` | FIX WQ-102; TEST WQ-103 | Clear bounded configuration and sequential scanners with post-await abort guard. Acquisition before try, eager close expressions and first-only failure reporting weaken ownership; scanner failures are silently retried with no health surface. |
| `apps/worker/src/execution/core-definition-identities.ts` | KEEP exact versions; REFACTOR/TEST WQ-103 | Known Merge/Parallel versions are explicit compatibility policy. Structured-checkpoint selection duplicates API policy; inline function-valued ternary is a localized reading cost. Do not infer support for arbitrary future versions. |
| `apps/worker/src/execution/persisted-workflow-projection.ts` | KEEP verification; REFACTOR/TEST WQ-103 | Keeps admission/current releases distinct and checks persisted epoch against envelope. Optional-chain/sentinel fallback after preceding guards obscures proven state; prefer branch-local narrowed values without changing legacy no-support mode. |
| `apps/worker/src/triggers/trigger-handler.ts` | KEEP durable verification; TEST WQ-103 | Checks all available publication identities, delegates stale/not-found authority to transactional reconciliation, and avoids health writes for known permanent/stale failures. Cancellation stops at reader because reconciliation contract currently lacks a signal; coordinate any extension with its database owner. |
| `apps/worker/src/triggers/trigger-runtime.ts` | FIX WQ-102; TEST WQ-103 | Sequential claim/accept loop and post-commit metric containment are appropriate. Logger failure terminates loop; readiness succeeds before first scan/after close; shutdown waits indefinitely for raw scan; startup ownership has gaps. |
| `apps/worker/test/coordinator-engine.test.ts` | KEEP; TEST WQ-103 | Real graph/compiler/checkpoint and overlap release verify actual interface. Missing changed-state/no-output and missing-current/fingerprint paths deserve focused rows. |
| `apps/worker/test/coordinator-handler.test.ts` | KEEP; TEST WQ-103 | Strong exact signal/checksum/commit and no-change assertions. Existing throwing schedule metric already proves containment; retain it. Some repeated calls assert one error twice; capture once where it clarifies evidence. |
| `apps/worker/test/coordinator-runtime.test.ts` | FIX fixture; TEST WQ-102/WQ-103 | New abort/drain tests are useful; first and composition cases omit deadline scanner, composition also omits notification publisher. Real constructors can run in a unit suite. Pending repeated close and synchronous failures remain uncovered. |
| `apps/worker/test/core-definition-identities.test.ts` | TEST WQ-103 | One For Each case cast as never proves only schema selection; cover actual supported/rejected definition versions and real compiled graph cohorts. |
| `apps/worker/test/trigger-handler.test.ts` | KEEP; TEST WQ-103 | Stale/mismatch/transient distinctions and safe health reason are useful. Add all identity mismatches, reader/health failure and exact checksum assertions. |
| `apps/worker/test/trigger-runtime.test.ts` | KEEP; TEST WQ-102/WQ-103 | Dependencies are injected; transient readiness and setup-failure tests are useful. Immediate scanners do not prove no overlap; test claiming routing plus cleanup exercises only cleanup. Missing close-pending/logger/telemetry-construction cases. |
| `apps/worker/test/retained-core-workflow-v2.test.ts` | KEEP; TEST WQ-103 | Reads retained fixture, rebuilds exact checksum and executes pinned pairs. Must also prove execution entries cover every intended node; empty/missing entries currently weaken the loop's broad title. |
| `apps/worker/test/compatibility-rollout.test.ts` | KEEP limited claim; TEST WQ-103 | Executes manual in both registries and rejects wrong fingerprint. This is not every exact pair or deployed rolling cohort qualification; title should reflect the sample or table should cover advertised pairs. |
| `apps/worker/test/execution-import-boundaries.test.ts` | TEST WQ-103 | Narrow regex checks four files for one spelling of type import. Inline type imports, aliases/double quotes/re-exports can evade intended dependency rule; use existing import analysis or a small TypeScript AST assertion. |
| `apps/worker/test/support/execution-engine.fixture.ts` | KEEP | Small valid manual-to-terminate graph with real mapping semantics supports both engine tests. Shared IDs and pure factory are appropriate. |
| `apps/worker/test/support/compatibility-release.fixture.ts` | KEEP protocol; TEST/FIX WQ-103 | Explicit prepare/probe/preactivate/approve/activate mirrors authority sequence. Three acquisitions precede try and cleanup ignores failures; preserve original failure while attempting every owned close. Never use this helper against an unqualified shared database. |
| `apps/worker/test/fixtures/retained-core-workflow-v2.json` | DATA/KEEP | Parsed strict metadata; three-node graph, exact V2 envelope/release/checksum and three execution examples checked by passing retained test. Immutable compatibility evidence must not be regenerated merely to accommodate a breaking implementation. |

## WQ-102 — complete coordinator/trigger runtime ownership and supervision

Priority P1/P2 FIX. Integrate with WQ-057/WQ-096 and PF-02/PF-03; these are
additional owners, not permission for a generic lifecycle framework.

Exact locations: `coordinator-runtime.ts:174–226,230–277`;
`trigger-runtime.ts:122–191,194–254`. Constructors for stores/readers/scanners,
publisher and telemetry run before the protected consumer construction.
Trigger telemetry is constructed after the consumer but outside rollback.
Startup failure can strand already acquired resources. Close currently uses:

```ts
const consumerResult = await Promise.allSettled([consumer.close()]);
const loopResult = await Promise.allSettled([scannerLoop]);
const adapters = await Promise.allSettled([scanner.close(), reader.close()]);
```

Eager calls throw before allSettled can observe them. Coordinator local probe:
synchronous consumer.close failure produced zero sibling closes. Trigger
deferred-scan probe: after 35 ms, consumer closed once but close remained
pending and none of scanner/reader/reconciliation closed. Releasing the scan
allowed orderly completion; checkReadiness still resolved after close. The
probe is not a claim that 35 ms is the intended deadline: no deadline exists
on that path at all. Coordinator already has a bounded scanner-loop helper;
retain its explicit post-due-scan abort check and extend actual ownership,
not just add more Promise.race calls.

Implementation sequence:

1. Validate pure configuration/release data before ownership acquisition.
   Protect the entire acquisition chain, including telemetry and trace setup.
   Register each successful owned acquisition immediately. Specify injected
   adapter ownership consistently with existing runtime contracts.
2. Cache one close result. Mark terminal/readiness state synchronously, abort
   scans, drain consumer before dependencies it uses, then drain/cancel raw
   scanner work with the existing bounded shutdown policy. Attempt every
   independent closer through deferred thunks; preserve primary plus cleanup
   failures, not only the first reason. Do not close shared database owners
   while raw work still uses them without a documented forced-close policy.
3. Trigger scan catch must contain logger.error. Local injected logger probe
   observed one scan, then one unhandled rejection and no next scan after
   35 ms at 10 ms poll. Observe the loop promise immediately; logging failure
   cannot disable scanning or become an unhandled rejection. Retain metric
   containment. Abort-driven shutdown should not be recorded as an ordinary
   new operational failure unless that classification is intentional.
4. Make readiness reject once closed. Define first-scan readiness explicitly
   (do not report health solely because no result has arrived). Coordinator's
   scanner failures are currently swallowed and absent from its runtime
   readiness interface: add bounded diagnostics/health evidence through the
   existing worker readiness composition, without replacing retry resilience.
   Thresholds must be operationally justified; do not crash on every transient
   database error or silently declare persistent failure healthy.

Acceptance: partial startup failure at every acquired owner; sync/rejected and
never-settling close; concurrent repeated close returns same outcome; abort
before/between/after scans; no work starts on closed adapters; late work cannot
resurrect readiness; logger/metric failure does not terminate loop; original
and all material cleanup errors retained; no dangling rejection/timer. Exercise
the actual runtime interface with every dependency injected. A database-backed
check for cancellation settlement is a separate qualified integration gate.

## WQ-103 — targeted readability, compatibility and fixture corrections

Priority P2 TEST/REFACTOR, P3 small expression improvements. Locations are the
file ledger above; preserve the existing workflow admission and replay rules.

- Shared checkpoint policy: API `initial-workflow-checkpoint.ts:16–30,70–81`
  and worker `core-definition-identities.ts:31–58` currently match. A narrowly
  named engine-owned initial-checkpoint factory can centralize engine version,
  iteration budget, next sequence and structured-schema selection, if its
  interface is smaller than two copies. Otherwise keep application wrappers
  and add a cross-application parity table. Never import API from worker.
  Replace the function-call ternary with a named selected factory only if this
  makes the policy easier to read; V1/V2 selection is intentional compatibility.
- `persisted-workflow-projection.ts:19–40`: narrow supported-current/admission
  values inside the support-present branch, eliminating sentinel epoch=0 and
  empty fingerprint after a guard has already required both. Keep no-support
  mode, alreadyAdmitted=true, exact release verification and envelope/column
  epoch equality. Trigger initial admission is not already-admitted execution;
  do not merge those modes accidentally. Test column/envelope mismatch for
  scheduled admission at the real persistence seam before claiming it bypasses
  a database invariant.
- Coordinator handler table: every loaded/published non-ready result, all
  identity mismatches, not_found commit, stale/deferred/already_committed,
  completedOutputs forwarding, absent traceparent, rejected notification,
  acknowledgement failure. Existing metric-failure test remains. Assert no
  later dependency is invoked on failure and preserve original adapter cause.
- Coordinator engine: no_change only when all effects and revision-normalized
  state are equal. Test state-only transition, consumed observations and
  relevant checkpoint variants; don't change deep comparison to shallow keys
  merely for speed without evidence. Test missing support/current, unsupported
  fingerprints and exact epoch disagreement at projection interface.
- Core identity table: undefined, wrong key/version, Condition/Switch/For Each
  v1, Parallel/Merge v1–v3, simple graph and structured graph. Known Merge alone
  is not automatically a reason to choose V2. Prefer authentic compiled
  fixtures for end-to-end selection; isolate tiny predicate fixtures honestly.
- Unit isolation: `coordinator-runtime.test.ts` must inject BOTH scanners and
  notifications in every runtime case. Add constructor/network-sentinel tests
  so future missing dependencies fail before real local services are touched.
  Restore/close in finally; settle deliberately blocked fake scans after timeout
  tests so late-completion fencing can also be asserted. Share a fully specified
  runtime fixture with deliberate overrides instead of partial adapter spreads.
- Trigger tests: deferred scan proves maximum active=1; await a controlled
  failure/next-scan signal rather than racing a transient readiness window.
  Add wrong queue job, identity mismatch in each field, failed recordFailure
  preserving cause, exact canonical checksum, invalid numeric/nonempty owner
  bounds and no construction on invalid options. Current six bounds cases do
  not cover every validation branch. Reconciliation cancellation propagation
  requires extending its persistence contract, not casting an extra property.
- Retained JSON: require nonempty unique execution IDs and equality with the
  intended retained node set. Keep immutable expected artifacts. Rollout test
  should either exercise all advertised pairs with valid examples or be named
  as a sampled compatibility smoke test; support descriptions are not readiness
  evidence for actual deployed processes.
- Import rule: reuse compiler/import analysis rather than build a repository
  scanner framework. Prove alternate import syntax is detected. Keep the
  independent capability module, not a test-driven reversal of that design.
- Compatibility fixture cleanup: protect acquisition chain and await all
  deferred closers with primary-error preservation. Keep production authority
  order and explicit actor/reasons; fixture convenience is not authorization
  to activate a deployment or modify a shared compatibility pointer.

Order: WQ-102 owner safety, unit isolation and regressions first; then parity
evidence before optional checkpoint/projection cleanup. Source code and
integration services were not changed.
