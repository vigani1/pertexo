# Database compatibility authority and persisted checkpoint codecs

Date: 2026-09-12. Primary reviewer fully read these ten files. Both selected
unit suites passed: eight tests. Integration code was inspected, not executed.
Corrected injected-source probes made no database connection and confirmed the
rollback-disposal and diagnostic-loss results below. An earlier probe mistakenly
used `monitor` instead of `monitorLockWaits: false`, allowing the default local
monitor/checkout attempt; it was terminated and provides no successful database
evidence. No migration, service-backed suite or provider operation ran.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/compatibility/compatibility-release.ts` | KEEP; REFACTOR/TEST WQ-151 | Separates unbounded retained history from two-release serving overlap; SQL owns exact catalog matching and share locks. Catch-all mapping loses infrastructure causes. Compact JSON check is not node-sdk canonical fingerprint verification. |
| `packages/database/src/compatibility/compatibility-release-maintenance.ts` | KEEP; FIX WQ-150 | Four named privileged operations own their transactions and validate arguments before acquisition. Failed rollback is swallowed and the client is released as reusable. |
| `packages/database/src/compatibility/compatibility-release-readiness.ts` | KEEP; TEST WQ-151 | A leased pool with current/target checks is a useful deployment probe, not redundant infrastructure. Preserve borrowed-versus-owned close semantics and bounded overlap. |
| `packages/database/src/compatibility/persisted-workflow-checkpoint.ts` | KEEP; TEST/CONDITIONAL WQ-152 | Bounded descriptor-safe JSON normalization precedes strict V1/V2 schemas and named refinements. Initial checkpoint invariants are explicit. Internal consistency coverage differs from engine validation. |
| `packages/database/src/compatibility/persisted-workflow-checkpoint-refinements.ts` | KEEP; REFACTOR/TEST WQ-152 | Branch, scope, join-owner and loop-budget functions express real rules. One nested expected-loop-status expression can be named; do not flatten the whole state machine. |
| `packages/database/src/compatibility/testing.ts` | KEEP | Explicit test exports cover release parsing, locking, maintenance and readiness without changing serving role privileges. |
| `packages/database/test/baseline-compatibility-fixture.ts` | KEEP; TEST WQ-153 | Reads the historical 0017 catalog rather than current mutable release state. Hard-coded epoch/fingerprint needs an independent identity check; do not regenerate migration history. |
| `packages/database/test/compatibility-release.test.ts` | KEEP; TEST WQ-151/WQ-153 | Three tests cover historical SQL, compact-format rejection and history/overlap separation. Ambiguous factory options throw before pool acquisition, so this selected suite is safe offline. |
| `packages/database/test/persisted-workflow-checkpoint.test.ts` | KEEP; TEST WQ-152 | Five tests preserve V1, canonical duplicate selections, scoped For Each and negative loop invariants. Merge evidence is only one valid settled case; add invalid cross-field cases. |
| `packages/database/test/compatibility-release.integration.test.ts` | KEEP; FIX fixture/TEST WQ-153 | Real cohort, activation replay, grants and function drift proofs are valuable. Owned random databases are appropriate, but forced pre-drop, ordered rollout stories and incomplete cleanup/evidence need work. |

## WQ-150 — discard the compatibility-maintenance client when rollback fails

P2 FIX. `compatibility-release-maintenance.ts:89–111` owns BEGIN, local owner
role, operation and COMMIT. On any error it attempts rollback but discards that
failure and calls client.release() with no disposal argument:

```ts
} catch (error: unknown) {
  await client.query('rollback').catch(() => undefined);
  throw error;
} finally {
  client.release();
}
```

An actual-source injected-client probe made the prepare statement fail and then
made ROLLBACK fail. The original prepare error was preserved, but release received
undefined. This demonstrates missing disposal signaling, not a live observed
cross-command leak. PostgreSQL/driver failures can make transaction/session state
uncertain; pool reuse must not assume rollback succeeded, especially after setting
a privileged local role.

Track rollback failure explicitly and release with a destruction error/flag in
that case; keep the original operation error authoritative and record safe cleanup
context where supported. Ensure release happens once even if rollback/reporting
fails. Follow established workspace transaction hygiene instead of inventing a
new transaction framework. Do not replace this privileged global operation with
a tenant transaction or hold it across external deployment checks.

Tests: acquisition, BEGIN, SET ROLE, role read-back, statement, COMMIT and ROLLBACK
failure independently; successful rollback permits reuse, failed rollback destroys,
and original error identity survives cleanup. Shared runtime close remains the
caller's responsibility. A bounded real max-one-pool test should establish backend
replacement after uncertain cleanup where that behavior can be safely induced.

## WQ-151 — preserve diagnostic cause without changing fail-closed release checks

P2 REFACTOR/TEST. The six release-check catch blocks in
`compatibility-release.ts` replace all unexpected query failures with a new
CompatibilityReleaseMismatchError and no cause. A synthetic ECONNRESET through
lockExpectedCompatibilityReleaseWithClient returned that mismatch name with its
cause absent. The same public failure is used for an actual unsupported release.
Both correctly prevent admission, but operators lose the distinction between
artifact drift and an unavailable database.

Keep the safe public failure contract if callers rely on it; retain a private
cause or bounded diagnostic category for query failure and reserve mismatch
evidence for actual returned/SQL authority mismatch. Verify upstream HTTP/readiness
serialization never exposes raw database text or credentials. Don't blindly map
every P0001 exception into a proven catalog mismatch. If consolidating repeated
catch logic, use one tiny private conversion rule, not a new error hierarchy.
For hostile arbitrary rejection tests, avoid unsafe instanceof/property traversal;
current production driver errors are ordinary Errors, so qualify that requirement.

`parseCompatibilityReleaseExpectation:39–71` verifies object header, byte bound
and JSON stringify round-trip. It does not sort canonical keys, validate the full
node-sdk release projection or recompute its fingerprint. Tests intentionally use
a minimal header with a fixed unrelated-looking fingerprint. Clarify that this
is an already-produced authority expectation, not the authoritative release
compiler. Either rename its "canonical V1" diagnostic/comment to the precise
compact round-trip check or document the trusted producer. Do not introduce a
second canonicalization algorithm in the database package. SDK/catalog tests
should own actual digest correctness; add exact-byte/whitespace/size cases here.

matchedExpectation validates epoch/fingerprint and returns the corresponding
expected release; it does not recompare returned catalog_json. Current SQL
lock_node_compatibility_current_supported (0019) compares all three fields before
returning and holds FOR SHARE on pointer/release. That is a legitimate SQL-owned
invariant, not a demonstrated missing catalog guard. Test the function contract
and readiness drift detection instead of declaring an exploit from a fake row.
Outside an explicit transaction, checkExpected calls only prove that moment's
readiness; mutation callers must retain the client transaction's lock lifetime.

Acceptance: real mismatch and query outage both fail closed, safe diagnostics
distinguish them, and current/target readiness, rolling overlap and lock-before-
mutation behavior remain unchanged. No removal of retained release history.

## WQ-152 — specify and test database-versus-engine checkpoint validation coverage

P2 TEST/CONDITIONAL; reproduced codec discrepancy, not yet a proven accepted bad
commit. `persisted-workflow-checkpoint.ts:124–164` gives joins shape validation,
and `persisted-workflow-checkpoint-refinements.ts:107–139` checks invocation/scope
ownership. They do not validate ledger branch uniqueness, count <= ledger size,
selected IDs, or mutually exclusive satisfied/unsatisfied outcome. A direct source
probe used one skipped branch, count=2, selectedBranchIds=['missing'] and an
unsatisfiedReasonCode simultaneously. The database codec accepted it; the engine
parseCheckpoint rejected it with "join count exceeds declared branches".

Before claiming a durable-write defect, trace coordinator plan/delta/commit
validation and retained-row loading, which add checks beyond this codec. Record
which layer owns shape, internal checkpoint consistency and executable-topology
consistency. Database code should not import the whole workflow engine merely to
avoid duplication; preserve the dependency direction and retained V1 semantics.
If database admission promises internal consistency, add equivalent private join
refinement and shared conformance fixtures. If it intentionally leaves a check
to another mandatory layer, prove that path rejects before mutation and document
the narrower codec contract. A normally trusted engine output is not an arbitrary
public HTTP input, but corrupt retained state still needs fail-closed handling.

Test matrix: duplicate branch IDs, policy count too large, selected missing/
nonarrived IDs, pending settled join, both outcome fields, inconsistent reason,
duplicate join identity and correct all/any/count cases. Add malformed/missing
scope ownership and output-reference mismatches. Run the same supported fixtures
through engine parse, database parse and serialize/parse round trip; annotate
intentional legacy normalization differences rather than demanding object equality
where defaults differ. Preserve deduplication of identical branch selections and
rejection of conflicting selections.

For loops, `refineLoopsBudgetAndWaits:159–163` embeds a nested conditional for
the control status. Name the value once:

```ts
const expectedControlStatus = loop.terminalStatus ??
  (complete ? 'succeeded' : 'waiting');
```

Keep the rest of ownership, collection, scope, ordinal and budget conservation
checks explicit. Stringifying small schema-normalized scope/output records is
not itself a performance defect; only replace with semantic equality if tests
show clearer code. invocationKeyBytes currently uses string length; qualified
executable-generated keys are encoded ASCII. Don't change durable key admission
without testing actual valid scopes. Graph loop limits are 1,000, so the codec's
1,000 ordinal bound is not evidence that current valid loops require 10,000.

Acceptance: each invariant has a named owning layer and negative test, retained
V1 and loop-free V2 remain readable, and no migration/checkpoint version changes
are introduced solely for local readability.

## WQ-153 — make release rollout evidence independent and cleanup accountable

P2 FIX fixture/TEST. `compatibility-release.integration.test.ts:85–96` force-
drops random names before creation. A generated-name collision must fail rather
than delete someone else's database. Track successfully created targets and use
owned cleanup; afterAll's serial loop must attempt every drop even if one fails.
Ordinary compatibility suites should not migrate unrelated histories on import.
Keep historical fixtures where they provide independent evidence.

The maintenance test assumes the previous rollout test activated epoch 2, then
starts at that predecessor to activate 3. Give it its own known predecessor or
make the entire dependent rollout one explicit scenario. The test called
"upgrades ... without rewriting prior state" currently asserts only current
readiness/head after running migrations from 0018. Capture baseline release and
pointer/audit identities before upgrade and compare afterward; readiness alone
cannot prove unchanged history. Preserve the actual historical migration path.

Non-removal candidates often use arbitrary digest-shaped fingerprints while
mutating a catalog; several expected 23514 failures could arise from more than
one constraint. Assert the specific guard/constraint diagnostic and build
otherwise-valid candidates, so removal/retirement/duplication tests fail for the
named reason. Link a baseline-fixture test to the actual node-sdk digest producer
without rewriting 0017 or replacing its historical identity with today's release.

Cleanup problems: function-definition capture occurs before try, leaving pools
unowned if that read fails; multiple finally blocks swallow restoration failures,
then close pools serially. Register owners immediately, attempt all restores and
closes, and report errors while preserving the primary failure. These databases
are disposable, which limits persistent shared-state risk, but failed restoration
can still contaminate later cases and misattribute failure. pgCode's cause walk
has no cycle bound; reuse a bounded fixture error classifier if helpers converge.

Order: disposal regression/fix, fixture safety and stronger evidence, diagnostic
preservation, then checkpoint ownership/conformance before any validator change.
No source implementation, migration, commit or push changed in this review.
