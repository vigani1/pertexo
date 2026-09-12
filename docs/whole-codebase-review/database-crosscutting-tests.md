# Database cross-cutting verification and fixtures

Date: 2026-09-12. Primary reviewer fully read these 13 files. Four selected unit
suites passed: 28 tests, 543 ms. Integration suites were inspected, not run.

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/test/execution-value-persistence.test.ts` | KEEP historical migration contract | Explicitly distinguishes six durable-value backstops from unrelated smaller fields and does not impose a new JSON shape on legacy data. Text checks supplement SQL behavior, not substitute for it. |
| `packages/database/test/execution-value-persistence.integration.test.ts` | KEEP; TEST WQ-200 | Clean/current-head and retained-0013 upgrade paths, exponent expansion, backstop drift and role isolation are valuable. Engine-range checkpoint fixture is not validated as engine-valid; title understates current migration head. |
| `packages/database/test/workflow-activation-projection.test.ts` | KEEP | Enumerates six persisted activation states independently of active/archived lifecycle and rejects invalid stored discriminants. Small helper expresses one complete stored row. |
| `packages/database/test/workflow-activation-projection.integration.test.ts` | KEEP | Serving-role list proves stored health is returned without fabricated normalization. One deliberate loop exercises a single public contract; no need for six separate fixture-heavy tests. |
| `packages/database/test/retention-transaction.test.ts` | KEEP; TEST WQ-194/WQ-195 | Invalid timeout/pre-abort tests prove no checkout. Add statement-timeout variants and cleanup matrix at the shared transaction owner rather than copying every case into each wrapper. |
| `packages/database/test/support/disposable-database.ts` | KEEP non-force drop; TEST WQ-200 | Identifier quoting and connection-disappearance observation are good. Five hundred queries plus sleeps is an attempt bound, not a strict elapsed deadline; partial create failure has no compensating cleanup. |
| `packages/database/test/inbox-cancellation.integration.test.ts` | KEEP; TEST WQ-200 | Proves receipt/outbox rollback and authoritative earlier commit/replay. queryStarted resolves before pg_sleep is observed on the server; test currently proves abort after write, not necessarily mid-statement wire cancellation. |
| `packages/database/test/retention-transaction-cancellation.integration.test.ts` | KEEP; TEST WQ-200 | Real lock observation, bounded rejection, vanished backend, rollback proof, replacement client and clean context form strong layered evidence. Drain pending work and release blocker even if observation/rollback fails. |
| `packages/database/test/regional-write-admission.integration.test.ts` | KEEP; TEST WQ-200 | Verifies startup versus serving-readiness distinction and exact 299999/300000 ms thresholds, stale evidence and replica identity multiplicity. Restoration silently swallows all errors; random-database pre-drop with force is unnecessary. |
| `packages/database/test/transient-data-retention.integration.test.ts` | KEEP; TEST WQ-200 | Bounded completed-idempotency deletion, defined key reuse, active sessions and concurrently locked logout retention are substantive. Reserve a client for the deliberately held owner transaction and compare exact retained IDs. |
| `packages/database/test/q9-bounded-work.test.ts` | KEEP measured-work distinctions; TEST WQ-201 | Batched input/scope lookups assert application query/client counts and output meaning. Setup time and non-attributable heap delta are honestly separated. Dynamic upper-bound discovery catches any parser failure, potentially shrinking the benchmark silently. |
| `packages/database/test/retention-inventory.integration.test.ts` | KEEP; TEST WQ-193/WQ-200 | Bounded inventory, no mutation, exact counters/audit, stale fences and serving-role denial are useful. Shared fixture relies on enforcement running after inventory; hardcoded API password replacement prevents non-local credentials. |
| `packages/database/test/retention-scheduling.integration.test.ts` | KEEP; TEST WQ-200 | Six concurrent claims, 26 workspaces across five classes, capacity signal and no duplicate batches/audits on repeated calls are meaningful. The variable named restarted uses the same adapter; this proves durable rescanning, not process restart. |

## WQ-200 — make integration evidence and teardown match their claims

P2 TEST/REFACTOR. These are concrete fixture corrections, not a request to replace
the test architecture. Use the existing disposable-database fixture and reserve
checked-out clients for explicit transactions. Collect teardown outcomes so one
failed close cannot skip every later close/drop. In dropDisconnectedDatabase,
use a real elapsed deadline and bounded observer queries; report remaining
sessions without force termination. Test quoted/invalid identifiers, partial
create/grant failure and cleanup timeout with a fake admin. Do not automatically
drop a database on create failure unless this fixture actually created it.

inbox-cancellation: queryStarted currently runs before the pg_sleep call. Observe
the intended backend/query using an independent pool before abort if the test
claims mid-statement cancellation; register rejection handling before any abort
and drain it in finally. Keep the commit-wins duplicate check. Retention's
blocked-query test already uses pg_stat_activity: retain that evidence, but put
pending outcome in outer scope and ensure blocker.release runs even if rollback
throws. Replace uninitialized pool teardown assumptions when setup fails.

regional-write-admission: restore the altered function in a guaranteed cleanup
scope, reporting restoration failure instead of ignoring it. A drift test must
not leave later tests running against a silently damaged schema. Keep the
steady-readiness assertion: it intentionally does not repeat expensive catalog
audits. Remove the unnecessary force-drop before creation of a UUID-named
database when adopting the existing fixture.

retention-inventory and retention-scheduling: derive serving URLs from the
configured DATABASE_API_URL plus the disposable database name; do not replace
maintenance credentials with a local literal password. Isolate inventory and
enforcement data or group the chronological scenario explicitly. Either rename
the scheduler's restart claim to repeat-call idempotence or close/recreate its
adapter and assert the same durable outcome. Preserve the exact 130 scanned
class rows versus 26 eligible input batches distinction, capacity bounds and
same-batch audit count; do not simplify these into only total success counts.

execution-value-persistence: keep retained legacy refs unchanged. Rename the
clean migration test to current-head bootstrap, not zero-to-0014. The
engineRangeCheckpoint uses a 32768-character engineVersion and omits a required
modern field: either call it a SQL-backstop-only body or generate a large valid
checkpoint via the established parser/engine fixture and assert that validity
before writing it. Do not claim raw SQL acceptance proves engine admissibility.
Retain the exponent-heavy JSON versus PostgreSQL numeric text-size distinction.

Acceptance: each independently advertised test runs alone, teardown still
attempts all owned resources after injected failure, restored schema is checked,
pool context does not leak, cancellation observation precedes abort and the
outcome is drained, and no external credential is fabricated. Existing local
service qualification is not implied by source inspection.

## WQ-201 — prevent adaptive benchmark setup from masking regressions

P2 TEST. q9-bounded-work.ts:63–80 uses a catch-all binary search for the largest
accepted fixture population. A new unrelated parser error above a small size can
be reinterpreted as the supported upper bound, while all measured tests still
pass. Preserve effective combined limits, but assert the expected upper bound
for each fixture shape/version, or require a specifically identified size-limit
failure at upper+1. Unexpected identity/shape/invariant errors must fail setup.
Record the declared bound, effective bound and limiting constraint explicitly.

The query fake proves batched application work, not a PostgreSQL query plan,
network roundtrip count, memory attribution or latency SLO. Keep those distinctions
in the Q9 output and consuming reports. Count/setup queries separately if a
report needs total SQL work; do not relabel applicationQueries. Add a synthetic
non-size parser failure to prove it is not converted into a smaller benchmark.
Retain small/middle/effective-upper populations, exact loaded values and one
acquire/release assertions. A threshold change requires contract review rather
than blindly updating expected numbers.
