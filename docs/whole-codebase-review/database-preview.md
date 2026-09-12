# Database preview acceptance and attempt lifecycle

Date: 2026-09-12. Primary reviewer fully read these 19 files. Three static tests
passed (109 ms); integration suites were read, not run. Actual-source probes with
injected clients reproduced changed-output duplicate acceptance and JSON-string
output parameters. A pure validator probe reproduced an escaping getter exception
and disagreement with production over an empty JSON property name. No provider,
database service, retention deletion or migration was executed.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/execution/preview-execution.ts` | KEEP | Explicit acceptance versus worker exports communicate authority and keep preview identity separate from production scheduling. Update only if a public helper is genuinely retired. |
| `packages/database/src/execution/preview-execution-acceptance.ts` | KEEP transaction phases; TEST/REFACTOR WQ-192 | Discriminated input, pinned release/draft, exact replay, bounded retention/deadline and same-workflow prior-output check are meaningful. Select only returned status fields; recursive executableNode validation needs the established bounded-JSON treatment, not an after-the-fact byte check alone. |
| `packages/database/src/execution/preview-execution-contract.ts` | KEEP; REFACTOR WQ-192 | Clear lease/disclosure/terminal result shapes. Move the status-pair lookup to a private immutable module constant if touched; rebuilding it per check is unnecessary but not a performance incident. |
| `packages/database/src/execution/preview-execution-delivery.ts` | KEEP | Distinct execution and reconciliation schemas bind all identities, checksum and fence. Missing foreign data is hidden by RLS, mismatch audit survives rollback, and receipt/outbox row counts are checked. Parallel functions encode different wire contracts; no generic transport framework is warranted. |
| `packages/database/src/execution/preview-execution-claim.ts` | KEEP lock and reclaim policy; TEST WQ-190; REFACTOR WQ-192 | Single logical attempt, increasing token, retained provider key/binding and atomic reconciliation wakeup are correct concepts. Unused expiresAt argument and selected lease_expired/run side-effect fields add noise. No database deadline gate is applied at claim itself. |
| `packages/database/src/execution/preview-execution-dispatch.ts` | KEEP connection binding; TEST WQ-190 | Exact owner/token/run identity and immutable provider binding are checked under a row lock. Unlike production, current lease expiry is not a predicate. Prove and settle this difference explicitly. |
| `packages/database/src/execution/preview-execution-heartbeat.ts` | KEEP database clock and tenant ownership; TEST WQ-190 | Returns execution deadline separately from retention. Renewal checks owner/token but neither current lease expiry nor run deadline; requested lease may be an hour. |
| `packages/database/src/execution/preview-execution-completion.ts` | FIX WQ-189; REFACTOR WQ-191; TEST WQ-190 | Terminal state, audit, usage and receipt write atomically. Duplicate fallback verifies too little, and serialized JSON is stringified a second time before ::jsonb. Preserve truth after possible provider effect. |
| `packages/database/src/execution/preview-execution-reconciliation.ts` | FIX WQ-188; KEEP decision order; TEST WQ-190/192 | Transport-bound reconciliation fences before redelivery and gives unsafe ambiguity precedence over timeout. Live lease reschedules even after deadline. Legacy direct reconciliation is a separate narrower path and must not silently acquire retry behavior. |
| `packages/database/test/support/preview-worker-fixture.ts` | KEEP actual role/scope and checked-out owner client; REFACTOR WQ-192 | Generates an isolated database, explicit identity and canonical delivery. Import-time pools/root hooks and close failures can bypass later cleanup; shared identity/sequence make mutation restoration important. |
| `packages/database/test/preview-worker-attempt-lifecycle.integration.test.ts` | KEEP; TEST WQ-188–WQ-192 | Exact audit/usage metadata, rollback, checksum audit and changed-fence checks are valuable. Output assertion is merely non-null, replay only compares the same failure, and shared workspace suspension lacks finally restoration. |
| `packages/database/test/preview-worker-reconciliation.integration.test.ts` | KEEP; TEST WQ-190/192 | Exercises pre/post-dispatch safety classes, durable rescheduling/redelivery/fence, preserved stable key and forged delivery. Timeout fixture derives execution and retention from the same 250 ms deadline, so does not prove their independence. |
| `packages/database/test/preview-worker-schema.integration.test.ts` | KEEP | Real permission checks and same-name altered-FK/function drift challenge readiness semantics. Restoration uses finally. Assert corruption setup succeeded before relying on a readiness rejection. |
| `packages/database/test/preview-worker-artifact-retention.integration.test.ts` | KEEP authority/lock proof; TEST WQ-192 | Preview ownership/expiry rollback and exact maintenance-ledger authority are substantive. Observes actual lock wait and zero open transactions during deletion. Short deadlines and teardown of a locally scoped hold promise need safer ownership. |
| `packages/database/test/preview-execution.integration.test.ts` | KEEP acceptance/read evidence; FIX/TEST WQ-192 | Atomic acceptance, rollback, replay after draft edit, tenant/prior-output rules are real tests. Uses configured/default database with TRUNCATE CASCADE, bypasses real completion when seeding output, and performs two failing permission operations in one already-aborted transaction. |
| `packages/database/test/preview-execution-deadline-migration.test.ts` | KEEP | Static source guard covers immutable deadline and RLS restore syntax; not itself evidence of a populated upgrade. |
| `packages/database/test/preview-execution-deadline-migration.integration.test.ts` | KEEP; TEST WQ-192 | Isolated prior-head upgrade verifies readiness, exact constraint and trigger hash. Empty-table upgrade does not exercise retained preview deadline backfill. |
| `packages/database/test/preview-retention-enforcement-migration.test.ts` | KEEP | Protects maintenance-only cleanup and verifies the revoked legacy implementation/testing export is absent. Historic SQL remains immutable; future changes use a new migration. |
| `packages/database/test/preview-retention-migration.integration.test.ts` | KEEP historical compatibility; TEST WQ-192 | Retained 0023 rows and terminal audit/usage backfill are valuable. Owner transaction uses Pool.query without reserving a client, and legacy input shape is not proof that retained rows are executable under the current reader. |

## WQ-188 — use one bounded output contract, with a total validation result

P2 FIX/TEST. reconciliation.ts:57–95 runs isStrictJsonValue before its try/catch.
Object.entries invokes enumerable getters, and getPrototypeOf can throw. The
claimed boolean validator therefore throws arbitrary exceptions. It also rejects
empty property names although the production stored-value serializer accepts
them. Actual-source results:

```ts
const output = { schemaVersion: 1, kind: 'inline', value: { '': 1 } };
serializeStoredExecutionValueV1(output); // succeeds
isValidStoredExecutionOutput(output);  // false
// An enumerable getter throwing Error('getter called') escapes the predicate.
```

Remove the competing recursive JSON traversal in favor of the existing bounded,
descriptor-based stored-value parser/serializer inside the guarded operation.
Preserve the executor-facing object envelope rule if serialized text is not an
allowed executor output; parser support for database text does not automatically
widen that public contract. No new validator dependency or recursive walk.

Acceptance: empty property names, null and null-prototype JSON objects according
to the canonical production contract; rejected getters without invocation,
throwing/revoked proxies, functions, symbols, sparse arrays, excessive depth and
bytes; false rather than an escaping exception for every invalid value. Add
actual preview-handler wiring coverage so an admitted output reaches completion
and invalid output follows the established safe outcome path. This aligns with
the existing stored-value safety work, not a replacement of that module.

## WQ-189 — a terminal preview duplicate must match its durable identity and value

P2 FIX/TEST. completion.ts:177–198 falls back after the guarded update affects no
row. It selects only status/output_ref by workspace and attempt ID. The checks
are only equal status and non-null output for success. Different output,
different safeErrorCode, wrong previewRunId or a different delivery can return
duplicate. A current-source fake-client probe supplied durable ORIGINAL output
and incoming CHANGED output and received `{ kind: 'duplicate' }`. This does not
rewrite the original result or prove cross-tenant exposure; it falsely labels a
mismatched command as exact replay and bypasses delivery/receipt validation.

Make the fallback load the exact attempt/run pair and bound delivery/receipt,
then compare canonical stored output or the safe failure code and terminal run
state. Retain exact replay after the original lease no longer exists; do not
require a live lease for a proven already committed duplicate. If completion
after reconciliation uses a replacement delivery, explicitly distinguish valid
no-op from a forged identity rather than checking status alone.

Acceptance: exact success/failure replay emits no additional facts/usage; changed
output/error/run/delivery fails with the stable error and no writes; missing or
divergent run state fails closed; original and replacement delivery cases are
specified. Check raw rows, receipt completion and audit/usage counts. Run these
against PostgreSQL as well as a narrow injected-client test.

## WQ-190 — specify and verify expiry versus fencing for preview ownership

P2 TEST/CONDITIONAL. This is source-confirmed behavioral divergence, not a proven
duplicate provider call. Production dispatch, heartbeat and active completion
require lease_expires_at > clock_timestamp(). Preview equivalents only check
running/owner/token. Thus an expired but not yet reconciled owner can renew or
mark dispatch. Claim has no execution_deadline_at gate, and reconciliation checks
live lease before expired run deadline. An hour-long heartbeat can defer its
next check well beyond the five-minute execution maximum. Normal workers use
short leases and execution AbortSignal, so do not claim every preview runs late.

Under ADR-007/016, write tests with expiry and fence varied independently, not
only the existing expire-then-reclaim test that changes both. Prove which owner
may renew/mark, whether a post-deadline claim can reach the provider, and when an
expired-deadline/live-lease wakeup may terminalize versus wait for truthful worker
evidence. Preserve provider-confirmed success and unsafe outcome_unknown; a
blanket deadline-based failure could destroy execution truth.

If expiry itself revokes dispatch/renewal authority, add database-time predicates
to those operations and bound renewal/wakeup by execution deadline. If token
replacement is deliberately the sole revocation point for preview, document that
contract and prove its bounded worker/reconciler behavior; do not silently call
it identical to production. Any consequential policy change needs the existing
ADR process before implementation, not an incidental readability refactor.

## WQ-191 — persist the canonical JSON envelope once, retaining read compatibility

P2 REFACTOR/TEST. completion.ts:151–167 and :201–220 use:

```ts
outputRef: serializeStoredExecutionValueV1(input.outcome.output)
// later passed to $7::jsonb / $4::jsonb:
JSON.stringify(outcome.outputRef)
```

The first result is already JSON text. Actual-source query capture shows parsing
the SQL parameter once yields a string, not the object envelope. Acceptance
input and production output persist objects. The preview reader accepts string
input, masking this representation drift, so this is not a claim that all
existing status reads fail. The integration test only asserts non-null output.

Pass serializedOutput directly to ::jsonb, with a name that makes its type
obvious. Keep reader support for previously stored JSON strings and add a
compatibility fixture; do not rewrite retained history solely for formatting.
Prove jsonb_typeof(output_ref)='object' for new run and attempt output, exact
canonical equality, real status reads and prior-preview reuse. Include inline
values with quotes/backslashes and top-level artifact envelopes. Keep existing
artifact link/retention authority separate from changing this encoding.

## WQ-192 — keep preview tests independent and trim concrete readability costs

P2 TEST/REFACTOR, with test-environment safety inherited from WQ-157. First move
preview-execution.integration to an owned disposable database before allowing its
TRUNCATE CASCADE setup; environment variables alone do not establish ownership.
Start monitored stores after fixture creation and dispose all constructed owners
even when checkout/migration/close fails. Reserve a PoolClient for explicit
transactions, including the retained-head upgrade test; do not rely on sequential
Pool.query happening to reuse one socket.

Split failing permission statements into separate transactions or explicit
savepoints. At present the second rejects because the first has aborted the
transaction, not necessarily because its own UPDATE grant is denied. Assert
42501 for each, alongside the existing direct has_column_privilege result.

Other exact work:

- Acceptance executableNodeSchema (acceptance.ts:35–40) recursively parses z.json
  before byte measurement. Apply the established bounded unknown-JSON admission
  approach at this seam; keep the accepted executable object and byte contract.
  readPreviewRun selects every column although it returns a small projection;
  select that projection without loading pinned input/executable JSON. These
  are source-level cost observations, not measured latency claims.
- Remove unused loadPreviewLease expiresAt parameter, lease_expired selection
  and unused run-side side_effect_class. Preserve attempt-side classification
  and exact pinned fields. Do not merge all nine files by line count.
- Move status-pair lookup outside previewPairConsistent, using a prototype-safe
  lookup or switch. Unknown persisted statuses must return false rather than
  calling includes on an inherited Object property.
- Split the large lifecycle/reconciliation scenarios by invariant; use finally
  for workspace status restoration. Preserve exact safe metadata assertions.
- Separate execution deadline from retention in timeout tests. A 250 ms shared
  deadline plus setup and sleep is both fragile and unable to prove independence.
  Use explicit future retained expiry, bounded database-clock polling and an
  intentionally short execution deadline established with enough setup margin.
- The artifact retention test's hold promise lives inside try; finally releases
  deletion and waits completion but cannot explicitly drain that hold on an
  earlier assertion failure. Register it with the outer owner, bound lock waits
  by elapsed time and per-query cancellation, and always close both pools even
  if coordinator close rejects. Retain actual pg_stat_activity lock evidence and
  proof that provider deletion runs without an open transaction.
- Seed retained rows before the 0069→0070 upgrade, including terminal and
  unexpired previews, and assert backfilled execution deadlines, immutable pins,
  retention, RLS and re-run behavior. The present empty-table schema test does
  not exercise the UPDATE backfill.

Order: safe test fixtures, WQ-188 and WQ-189 regression fixes, WQ-191 encoding
with legacy reads, then WQ-190 policy evidence and the private cleanup above.
Do not broaden preview into production graph execution or introduce a new retry
model while addressing these findings.
