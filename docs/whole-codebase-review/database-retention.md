# Database retention orchestration

Date: 2026-09-12. Primary reviewer fully read these eight files. A current-source
run-artifact coordinator probe used an intercepted pool, disabled monitoring and
a simulated external ledger. It reached delete after the external tail advanced
without another freshness check. This demonstrates application ordering, not a
live PostgreSQL/object-store incident. Integration code was read, not executed.
Additional retention integration suites are reviewed in the separate
[retention integration ledger](database-retention-integration.md); those
service-backed suites were inspected, not executed for this review.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/lifecycle/retention-contracts.ts` | KEEP | Separate dry-run, enforcement, scheduling and health results express real maintenance responsibilities. Historical workflow-run-input names now cover multiple retention kinds; changing public names requires caller-compatible migration, not cosmetic churn. |
| `packages/database/src/lifecycle/retention-support.ts` | FIX/TEST WQ-194 | Validated counts/options and row projection are useful. retentionQuery only checks abort before forwarding QueryConfig.signal, which does not own an in-flight node-postgres operation. Generic cursor tuples should gain exact shape tests before stricter decoding. |
| `packages/database/src/lifecycle/retention-database-capabilities.ts` | KEEP capability grouping; FIX WQ-194; TEST WQ-197 | Bounded dry-run pages, distinct standard/input SQL, least-privilege readiness and database replica observation belong here. Direct pool calls need cancellation ownership; result invariants and page-bound release need explicit evidence. |
| `packages/database/src/lifecycle/retention.ts` | FIX WQ-193/WQ-194; TEST/REFACTOR WQ-197 | Shared maintenance pool and short destructive transactions are appropriate. External freshness is checked outside the final destruction interval; catch reports released even if release fails and discards the initiating error. |
| `packages/database/src/lifecycle/preview-retention.ts` | FIX WQ-193/WQ-194; KEEP ownership/retention distinctions | Advisory lock spans prepare, object delete/head and completion without an open transaction across I/O. Ledger check occurs before acquiring that lock; options do not validate the two-connection requirement until work reaches the lock helper. |
| `packages/database/src/lifecycle/run-artifact-retention.ts` | FIX WQ-193/WQ-194; KEEP deferral semantics | Explicit pool minimum, retained-reference result, delete/head proof and aggregate error on failed deferral are valuable. External freshness proof precedes the session lock; a current-source interleaving reached deletion with a newer external tail. |
| `packages/database/src/lifecycle/transient-data-retention.ts` | FIX WQ-194; KEEP narrow SQL authority | One bounded maintenance function with decoded counts is a good interface. Signal forwarding is not wire cancellation; validate pageSize at this exported seam or document its trusted-only caller contract. |
| `packages/database/test/retention-legal-hold.integration.test.ts` | KEEP existing scenarios; TEST WQ-193/WQ-197 | Proves already-ahead external ledger releases work and already-projected hold pauses it. Does not test a ledger append between successful freshness check and destruction. Pool-based owner transactions and shared fixtures inherit WQ-157 cleanup/isolation work. |

## WQ-193 — preserve external-ledger freshness across destructive authorization

P1 FIX/TEST. Read together: retention.ts:123–217;
run-artifact-retention.ts:114–171; preview-retention.ts:155–227;
workspace-purge.ts:358–465; control-ledger-coordinator.ts command:659–873.

Current artifact ordering is:

```text
read projected anchor in short transaction → release
external ledger says exactly projected
                     [external append can advance the ledger here]
acquire workspace destructive advisory lock
prepare using unchanged PostgreSQL anchor → delete → checkpoint
```

The fake-ledger source probe advanced the external sequence from 0 to 1 when the
subsequent advisory lock was acquired, left projected sequence at 0 and returned
an otherwise valid prepare result. Observed: one reconcile, one delete and
completed. Existing SQL anchor checks cannot detect an unprojected external
record. The control command's append occurs between transactions, without its
advisory lock; append-success/projection-failure is explicitly supported and
already tested. Even moving only the reader's ledger call under its session lock
does not serialize an append that does not share that lock.

ADR-013 makes the independently retained ledger authoritative and requires newer
or unavailable ledger state to pause destruction. Preserve that contract with
one explicitly specified serialization protocol across legal-hold append/
projection and destructive authorization. A possible implementation is a
workspace session-lock interval covering the final external freshness check and
destructive step, with all relevant append owners participating in the same
ordering. Keep short database transactions and the reserved transaction pool
slot: do not hold a database transaction over network I/O or nest acquisition of
the same advisory lock through a different pooled connection. If a durable
in-progress append fence is chosen instead, define crash repair and stale-owner
behavior before implementing it. Resolve this cross-module invariant centrally,
not by independently changing each coordinator.

Acceptance requires deterministic real-database interleavings with an injected
ledger: successful freshness check followed by a newer committed hold record;
append succeeds but projection fails; append is ambiguous/one-sided; fully
projected hold; release; and deletion already in progress. No next destructive
step may start from stale proof. Hold acknowledgement must still wait for an
already authorized physical deletion to finish. Assert exact object call count,
row preservation, ledger/projected anchors, zero open transactions during I/O,
pool capacity and recovery after interruption. Cover standard/input retention,
preview artifacts, run artifacts and workspace row/object purge separately.
Do not claim current tests of an already-present hold cover this interleaving.

## WQ-194 — make maintenance SQL cancellation real and owned

P2 FIX/TEST, extending the verified node-postgres cancellation findings in the
database foundation/operator ledgers. retention-support.ts:46–59, local query
helpers in preview/run-artifact retention and transient-data-retention.ts pass
signal to pg after a pre-check. The pinned driver does not reliably cancel an
already-sent query that way. Pool statement budgets limit some waits but do not
make caller cancellation immediate or prevent a mutating function committing
after cancellation. Retention's inRetentionTransaction already owns checked-out
wire cancellation; keep it.

Route direct claim, schedule, reap, release and health queries through the
existing owned platform transaction/query mechanism as appropriate. Distinguish
mutations that need rollback from observations. Validate returned mutating
function results before commit where fail-closed decoding is required. Never
solve this with Promise.race alone while returning a busy client to the pool.
Preserve security-definer grants and global maintenance authority: do not add a
fake workspace scope to global scans.

Acceptance: already-aborted, queued checkout, blocked statement, abort immediately
after query completion and lost-connection cases; underlying operation disposed,
client capacity recovered, no post-abort mutation unless the commit had already
won, and truthful outcome in that race. A fake that itself honors signal proves
forwarding, not pinned-driver cancellation. For object/ledger operations, timeout
is cooperative: keep the destructive session lock until the underlying work has
settled/disposed, rather than returning on a race while deletion continues.

## WQ-197 — make retention outcomes and cleanup evidence honest

P2 TEST/REFACTOR. retention.ts catch:225–240 swallows any cause, attempts release
with the same possibly aborted signal, swallows that failure and returns
`status: 'released'`. The lease can still be held until expiry. Separate expected
ledger-not-current/fence/hold decisions from unexpected database or decoding
failure. Preserve the original cause and release outcome through the existing
safe reporting seam; do not leak ledger records or tenant payloads. Report
released only when its durable release is known, or name/document a distinct
deferred-to-expiry result. Cancellation should retain the caller's reason.

Dry-run processNext throws at maxPagesPerBatch without explicit release; decide
and test immediate release versus documented lease-expiry recovery. Decode
eligibleDelta <= examinedDelta consistently on enforcement as on dry-run, and
scheduledCount <= scannedCount on scheduling. Test malformed tuples/counts,
stale lease, bounded partial progress and unchanged exact results. These result
checks are defensive integrity tests, not evidence that valid SQL emits bad rows.

Only after regression coverage, extract a private exact-projection predicate
and result builders if they reduce repeated protocol knowledge. They must be
part of WQ-193's ownership model, not helpers that hide a stale check. Preserve
the different preview quiescence, run-artifact reference/deferral and standard
retention semantics. No generic lifecycle framework or condition-count target.
