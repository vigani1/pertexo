# Database control-ledger coordinator and read side

Date: 2026-09-12. Primary reviewer fully read these eight files. All 20 unit tests
passed (2.38 s). Both integration suites and their fixture were inspected, not
run. A public source probe reproduced clean client release after rollback rejects
with undefined. External append ordering is also part of WQ-193 in the retention
ledger; no real ledger record was written.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/lifecycle/control-ledger-coordinator.ts` | FIX WQ-193/WQ-195; REFACTOR/TEST WQ-196 | Bounded page/record/anchor retries, exact command repair, multi-sweep inventory digest and separate short transactions are meaningful. Append is outside the lock interval; rollback/unlock failure state conflates absence with undefined rejection. |
| `packages/database/src/lifecycle/control-ledger-postgres.ts` | KEEP eventual-client release; TEST WQ-195 | Pool wait races release a late pristine client; external races remove listeners. Best-effort pg_cancel_backend uses a separate timed pool whose raced query/end can outlive the helper. QueryConfig.signal alone is not wire ownership. |
| `packages/database/src/lifecycle/control-ledger-read-side.ts` | KEEP cursor/authority validation; FIX/TEST WQ-194/WQ-195 | Complete composite cursor, limit+1, safe byte count/hash and narrow restore readiness are good. Once acquired, read query cancellation has no direct disposal owner. Confirm strict cursor ordering/oversized return behavior with injected malformed rows. |
| `packages/database/src/lifecycle/control-ledger-errors.ts` | FIX WQ-195 | Stable errors are useful. controlLedgerClientReleaseError cannot distinguish successful rollback from rollback rejecting undefined with its current parameters. |
| `packages/database/test/control-ledger-coordinator.test.ts` | KEEP; TEST/REFACTOR WQ-193/WQ-195/WQ-196 | Substantive append repair, exact replay, bound and inventory stabilization scenarios. Fake logs transactions but does not represent advisory-lock ownership or concurrent checkouts; timeout tests prove prompt return, not cancellation of noncooperative side effects. |
| `packages/database/test/support/control-ledger-coordinator.integration.support.ts` | KEEP isolated prior-head data; TEST WQ-196 | Explicit fixture lifecycle and exact historical cohort are useful. Pool.query transactions, cleanup short-circuiting and in-memory ledger's simplified hash/idempotency semantics must remain visible limitations. |
| `packages/database/test/control-ledger-coordinator.integration.test.ts` | KEEP; TEST WQ-193/WQ-195/WQ-196 | Tests restricted roles, cursor paging, chunk progress and row-lock cancellation. Several coordinators close only on happy path; 100 ms sleeps infer lock state. Title says 0045→0047 although fixture reaches 0086. |
| `packages/database/test/control-ledger-coordinator-part-2.integration.test.ts` | KEEP; TEST WQ-193/WQ-196 | Append-success crash repair, chronological deletion/restore/purge transitions and hold rejection are meaningful. Pure projection tests deliberately do not prove physical deletion; retain that distinction and close coordinators on all exits. |

## WQ-195 — cleanup failure state must not reuse a contaminated client

P1 FIX/TEST for rollback disposal; P2 for cancellation ownership. In coordinator
transact:428–451, rollbackError starts undefined and receives the rejection
value. errors.ts:21–29 then treats undefined as success. Current-source injected
probe: operation throws Error, rollback rejects undefined, unlock succeeds,
public rejection preserves operation Error, but client.release(undefined) marks
the connection reusable. Unknown rejection values are allowed in JavaScript.

Track rollbackFailed and unlockFailed separately from their unknown reasons,
then dispose the client on either failure. Preserve both initiating and cleanup
causes where exposed by the existing contract. Reuse the established transaction
engine if its authority/lock semantics match, not a newly invented generic
wrapper. Do not let a cleanup classifier's instanceof/getter throw skip release.

Also review the command transaction's abort side channel: advisory acquisition
precedes BEGIN/SET LOCAL lock and statement timeouts, so those options do not
bound the initial advisory wait. The callback requests pg_cancel_backend, but
the helper races its query/end and does not guarantee disposal on failure.
Use the existing destructive-lock wait cancellation owner where compatible,
destroying only the checked-out waiting client and preserving lock lifetime once
destructive work starts. Read-side queries need their own bounded checked-out
owner (WQ-194), not merely a before/after signal check.

Acceptance: rollback and unlock reject Error, string, null and undefined;
exactly one destructive client release and no pool reuse; initiating failure
preserved; successful rollback still permits reuse. Test abort during checkout,
advisory wait, SQL wait and external I/O, cancellation side-channel failure and
late settlement. Distinguish commit-already-won from rollback, and prove locks,
listeners, cancellation-pool work and eventual clients are disposed. No network
test should be called a pure unit test because it points at an unreachable IP.

## WQ-196 — simplify the control command phases, keeping bounded recovery visible

P2 REFACTOR/TEST. command:659–873 repeats projected replay field comparison and
result construction in prepare and repaired phases. Extract one private
decodeExactProjectedReplay(row,input,commandType) used by both; keep mismatch
rejection and replayed=true semantics exact. Retain the distinction between
prepare authorization, reconcile, project fetched records, repair lookup, append
and final projection. A large ordered protocol is not improved by hiding all of
it behind generic callbacks. Name the phases and make each lock/transaction
lifetime explicit as part of WQ-193.

assertRecord currently validates material with Zod but ignores normalized return
values. Specify whether ledger records must already be canonical or are admitted
after normalization; preserve hash/chain material and do not trim/rewrite signed
records in a refactor. Test invalid sequence/hash/UUID/date, page end mismatch,
oversized/empty-hasMore pages and false projection return. project() returns a
boolean that callers discard; prove SQL's false result means exact replay before
reporting a new projected high water on that basis.

Repair the fake's concurrency fidelity before using it as WQ-193 proof: allocate
distinct checked-out clients, model lock ownership and record append intervals.
Keep simple sequential fake tests for protocol decisions, and use PostgreSQL for
real lock isolation. Ensure the hanging ledger fixture observes already-aborted
signals after callbacks too; attaching a listener after abort can otherwise hang.

Integration cleanup belongs in finally, with every pool attempted even if an
earlier close fails. Reserve clients for explicit transactions, bound lock polls
by elapsed time and observe pg_stat_activity rather than 100 ms booleans. Keep
the exact historical migration cohort intentionally maintained; correct suite
titles rather than claiming an old head proves current startup compatibility.
Retain inventory lower-sorting insertion and stable zero-projection sweep tests;
those prove more than a single successful enumeration.
