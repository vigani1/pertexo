# Database runtime, transaction and telemetry review

Date: 2026-09-12. Primary reviewer fully read these 17 files. Five existing unit
files passed: 52 tests, 810 ms. Three integration files were read, not executed.
No PostgreSQL service ran. Diagnostics probe used the real source pool with lock
monitoring disabled and no checkout. Monitor reference-count probe evaluated
the actual TypeScript source with injected fake pools/timers, not a SQL server.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/config.ts` | KEEP; TEST WQ-131 | Explicit immutable environment-to-runtime parsing, bounded conservative role pools, separate migration authority and production fence requirement. Small role parser repetition exposes distinct environment contracts; no generic role factory needed. Add boundary matrices rather than collapse into dynamic key casts. |
| `packages/database/src/database.ts` | KEEP | Small cohesive workspace repository interface hides lease ownership, transaction hygiene and full-versus-serving readiness. Rejects ambiguous single/set release expectations before resource acquisition. |
| `packages/database/src/platform/database-runtime.ts` | KEEP; TEST WQ-130/WQ-131 | WeakMap proves package-created runtime and exact configuration identity; borrowed leases cannot end the shared pool; standalone owners cache their close result. Do not replace with reference counting or broad public pool access. |
| `packages/database/src/platform/postgres-pool-policy.ts` | KEEP; TEST WQ-131 | Named role deadline table is clearer than branching factory conditions. Positive safe-integer validation preserves explicit overrides. Clarify defaults versus hard maxima; current overrides may exceed defaults. |
| `packages/database/src/platform/postgres-pool-checkout-telemetry.ts` | KEEP; TEST WQ-131 | One adapter preserves promise/callback checkout forms, records bounded role/outcome and wraps per-checkout release. Verify success, callback errors and repeated same-client checkout—not just failing promise checkout. |
| `packages/database/src/platform/postgres-telemetry.ts` | FIX/TEST WQ-129/WQ-130; REFACTOR WQ-131 | Meaningful bounded SQL-operation metrics, aggregate pool roles and lower-bound lock sampling. Error classification escapes the guarded diagnostic call; raw names are not bounded. Duplicate pool end decrements shared monitor references twice. |
| `packages/database/src/platform/persisted-id.ts` | KEEP | Single UUIDv7 generation policy is a useful tiny seam; do not inline it merely to remove a small file. |
| `packages/database/src/validation/persisted-primitives.ts` | KEEP | One canonical lowercase SHA-256 schema prevents drift among persisted checksum validators. Small public/internal vocabulary file is justified. |
| `packages/database/src/tenant-access/workspace.ts` | KEEP; TEST/document WQ-131 | Centralizes checked-out client, local tenant settings, read-back, rollback, connection destruction and late checkout disposal. Distinct platform/read-only/workspace facades express real authority; lifecycle booleans represent real protocol phases. Keep single owner and cancellation semantics. |
| `packages/database/test/config.test.ts` | KEEP; TEST WQ-131 | Immutable/default roles, explicit overrides, migration fence and upper conservative pool bound covered. Extend invalid URL/role/timeout and per-role limits; existing typed parser matrix is readable. |
| `packages/database/test/database-runtime.test.ts` | KEEP; TEST WQ-130/WQ-131 | Proves one shared pool, borrowed no-op close, mismatch and standalone ownership. Cover every authority field, forged runtime, failed close memoization and lifecycle precondition. |
| `packages/database/test/persisted-id.test.ts` | KEEP | Bounded uniqueness/version/lexicographic ordering test exercises the actual generator; do not assert system-clock timings or distribute it into micro-tests. |
| `packages/database/test/postgres-telemetry.test.ts` | KEEP; TEST WQ-129–WQ-131 | Useful finite role/metric/secret-message checks and undefined end rejection. Fake query cannot represent undefined rejection, checkout success unimplemented, and monitor tests don't assert close counts; strengthen those exact gaps. |
| `packages/database/test/workspace-transaction-engine.test.ts` | KEEP; TEST/refactor WQ-131 | Detailed fault matrix covers context leakage, both settings, timeout, rollback, release and several acquisition cancellation races. Preserve it; repeated miniature query simulators may share named statement-state fixtures without hiding fault location. |
| `packages/database/test/database-runtime.integration.test.ts` | KEEP; TEST WQ-131 | Real application-name session accounting checks pool sharing and complete shutdown. Exact four-session expectation depends on concurrent checkout timing; barriers should prove three business checkouts plus one sampler. Register ownership before repository creation. |
| `packages/database/test/postgres-telemetry.integration.test.ts` | KEEP; FIX fixture WQ-131 | Real held advisory lock is stronger than mere Promise.all contention; tests also exercise real release and checkout. Fixed lock key, pre-try acquisitions, unowned pending query and sequential cleanup can interfere or strand resources on failure. |
| `packages/database/test/tenant-context-hygiene.integration.test.ts` | KEEP; TEST WQ-131 | Real session-level GUC leakage, rollback and wire cancellation tests preserve important PostgreSQL semantics. Clean next checkout alone does not establish same connection reuse or destruction; assert backend identity/absence and gate cancellation on query entry. |

## WQ-129 — classify pool diagnostics inside the nonthrowing boundary

P2 FIX/TEST; extend PF-02's fixed diagnostic policy, not a competing helper.
`postgres-telemetry.ts:errorType:101–103`, idle-pool handler `:554–560` and
lock-sample catch `:457–467` evaluate errorType(error) before safeDiagnostic.

```ts
safeDiagnostic(options.diagnostics, {
  operation: 'idle_pool_error',
  poolRole: role,
  errorType: errorType(error), // Error.name/prototype inspection outside try
});
```

Local current-source probe: arbitrary synthetic name forwarded **true**;
throwing name getter escaped **true**; throwing prototype proxy escaped **true**.
No real credential was used. A normal pg error name can also be a nonstandard
driver class; this is an unsound bounded-reporting contract, not evidence of a
remote attacker controlling pg errors in production. On the async monitor catch,
classification failure can reject the void-started sample itself.

Plan: share the fixed vocabulary and guarded classification policy from PF-02
through an allowed dependency direction, or use a tiny package-local equivalent
until a real common leaf exists. Never read name/message/cause for labels. Guard
event construction and reporting together. Keep query text/parameters and
connection strings out of output, and preserve database outcome when reporting
throws. No changes to driver error propagation or database retries.

Tests: renamed Error, throwing name getter, getPrototypeOf proxy/revoked proxy,
undefined and primitive rejections, throwing diagnostics and meter callbacks.
Emit idle error and inject monitor rejection separately; no uncaught event throw,
unhandled sample rejection, raw secret marker or unbounded error label. Existing
tests using secret text only in Error.message are insufficient for this path.

## WQ-130 — release a shared lock sampler at most once per pool owner

P2 FIX/TEST. `postgres-telemetry.ts:acquireLockWaitMonitor:498–532` increments
references for each pool. The replacement pool.end (`:578–603`) always calls
monitor.close, even if originalEnd rejects because that same pool already ended.
It therefore consumes another pool's reference. Later closing that other pool
tries to end the sampler again. Runtime/standalone lease wrappers cache close,
which protects their normal paths; direct createDatabasePool owners exist in
lifecycle/operator modules and the testing export. Do not claim every ordinary
runtime close leaks or fails.

Actual-source probe with two same-authority fake pools, pg-like repeat-end
rejection and inert fake timers produced end-call counts in order
`[business A, monitor, business B]`:

| Step | Counts |
| --- | --- |
| close A once | `[1, 0, 0]` |
| close A again | `[2, 1, 0]` |
| close B | `[2, 2, 1]` |

The second close of A shuts down the monitor while B is open. Plan: one cached
release operation/reference token per pool, consumed exactly once, preserving
the selected pool.end API behavior and primary/monitor failure aggregation.
Prefer a clear locally cached close result if consistent with package ownership;
do not add cross-repository reference counting to DatabaseRuntime. If retaining
pg's repeat-end rejection, do not repeat sampler release while reporting it.
Handle overlapping close calls too, not just sequential duplicates.

Tests: A and B share sampler; duplicate/concurrent A close cannot stop B's
sampling or erase state; final B close stops timer/pool once. Inject first-end
rejection, including undefined, and monitor-end rejection. Existing sampler
end currently suppresses rejection (`:400–404`): choose explicit bounded
diagnostic/error handling instead of an unreachable outer aggregation promise.
Check pending sample is settled before final owner resolves and that timer
cannot launch a new sample after close. Keep lower-bound duration semantics and
per-authority/cadence sharing; do not claim cross-database locks are monitored.

## WQ-131 — tighten foundation evidence and local readability

P2 TEST/REFACTOR; runtime changes only where new behavioral proof warrants them.

1. **Telemetry forms and phase correctness.** Extend the unit fake to supply
   successful clients in promise/callback forms, reset release on each checkout
   like pg, and preserve original callback receiver/result/error. Verify query
   callback and promise success/failure, sync query throw, failed BEGIN, COMMIT,
   ROLLBACK, abandoned transaction, destroy-release, connection error/end and
   second checkout. Represent fake queued outcomes with discriminated records
   so undefined rejection is testable. Keep operation labels bounded; comments,
   WITH and unknown commands may intentionally classify as other, not require a
   SQL parser. The inspected installed pg-pool success callback supplies
   undefined, so the checkout success predicate is not a null-callback bug.
2. **Monitor test ownership.** Use fake clocks/deferred sample completion for
   unit cadence tests, and register pool cleanup before assertions so failures
   cannot leave real unit timers running. Assert no overlapping samples, stale
   observation cleared after failed sample, backend PID deletion, no duplicate
   duration on close, and shared reference release. Their claim is observed
   lower-bound duration, not exact PostgreSQL total lock time.
3. **Runtime and config contracts.** Table-test authority differences in URL,
   max, connection/idle timeout and owner/worker roles; reject a forged runtime.
   Preserve one cached rejection/resolve for repeated close. Document whether
   acquiring a repository after runtime.close is forbidden; test it and only add
   a closed-state guard if fail-fast behavior is selected. Don't silently create
   a new pool after close. Test timeout integer/range/environment coercion,
   invalid roles, protocol, fence, and pool bounds. DatabasePoolPolicy supplies
   defaults, not hard maxima—do not describe preserving arbitrary larger
   overrides as enforcing a process maximum. If hard timer/PG limits are needed,
   specify the integer bounds and error before introducing them.
4. **Transaction evidence.** Keep pre/post-use context checks and destroyed late
   checkout. Tests must distinguish callback failure before COMMIT, COMMIT
   failure/unknown acknowledgement, and post-COMMIT hygiene failure. The latter
   does not mean writes rolled back. Preserve existing outward errors unless
   caller retry semantics are separately reviewed. Add cancellation barriers
   between setup/read-back and callback entry and before COMMIT; forbid starting
   new SQL after the client is released. Arbitrary callback work that ignores
   abort cannot be forcibly canceled by this helper: document that callbacks
   own their non-SQL work and must not escape client/Drizzle references.
5. **Query simulator readability.** Use named fixture state transitions for
   context-free, tenant-scoped, committed/rolled-back and contaminated replies.
   Keep individual injected failure points visible. Do not merge genuine
   transactionOpen/clientReleased distinctions into a single boolean, replace
   the cohesive engine with callback policies, or remove explicit authority
   facades to save lines. Aggregate primary and cleanup errors remains valuable.
6. **Integration owners.** Runtime fixture: wrap acquisition and repository
   construction immediately, and end admin in finally even if drop fails.
   Telemetry fixture: unique advisory key per test, guard both checkouts,
   attach a rejection observer immediately to the waiting query, release holder
   before draining waiter, then unlock/release every acquired client despite
   another cleanup failure. Outer pool cleanup must also cover failed second
   checkout or re-checkout. The deliberate abandoned-transaction test may return
   a transaction to the pool to exercise instrumentation; document it and use
   destructive release at final teardown if rollback is not being tested.
7. **Non-vacuous live assertions.** In runtime sharing, gate all three checked-out
   business queries to make the four-session sample deterministic. In tenant
   hygiene, capture pg_backend_pid before and after; assert destroyed backend is
   gone and clean rollback reuses the intended max-one connection (or an explicit
   same-client proof). Existing max-three pool and a clean next checkout alone
   don't prove identity. Gate cancellation on actual slow query entry, dispose
   its timer in finally, and verify disappearance of the canceled backend before
   claiming wire-level drain. Fresh UUID database names remain scoped; avoid
   force-drop as routine setup and retain disconnected-database teardown.

Order: diagnostic safety and monitor reference bug, focused unit acceptance,
then integration fixture ownership/oracles and small readability improvements.
No new runtime framework, database service, migration, commit or push was made.
