# Database connection persistence and integration fixtures

Date: 2026-09-12. Primary reviewer fully read all 14 files below, including
shared fixture setup and all four integration suites. Relevant API/worker
callers and connection SQL policies were cross-checked. No live integration
test or provider request ran; concurrency extensions below are explicitly
qualification work, not claims of a reproduced production race.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/connections/connections.ts` | KEEP | One pool lease and focused implementations assemble the internal capability, then explicit API/worker projections enforce public ownership. Reuse injected runtime for tests as WQ-138 specifies. |
| `packages/database/src/connections/connection-persistence.ts` | KEEP; REFACTOR/TEST WQ-145; CONDITIONAL WQ-144 | Shared validation, codecs and transaction policy earn their locality. Manager/user role queries are duplicated policy and lack share locks; qualify revocation ordering before a lock change. |
| `packages/database/src/connections/connection-management-persistence.ts` | KEEP; TEST WQ-144/WQ-145 | Creation claim, secret, connection, two audit records and snapshot completion are atomic. Exact replay returns historical state even after rotation, intentionally. Revoke is idempotent; retain explicit transaction sequence. |
| `packages/database/src/connections/connection-secret-persistence.ts` | KEEP; TEST WQ-144/WQ-145 | Row lock plus expected current pointer protects rotation; new version insertion rolls back for a loser. Legacy replay and snapshot handling are repeated with management; localize equivalent decoding only. |
| `packages/database/src/connections/connection-resolution-persistence.ts` | KEEP; TEST WQ-144 | Current exact-provider secret and access event share a scoped transaction; share-lock on connection protects that snapshot. Do not hold this transaction open across KMS/provider I/O. |
| `packages/database/src/connections/connection-health-persistence.ts` | KEEP; CONDITIONAL WQ-145 | Standalone fixture/internal health observation is distinct from fenced connection-test completion. No current production role projection exposes it; don't redesign a hypothetical worker feature. |
| `packages/database/src/connections/connection-test-persistence.ts` | KEEP; TEST/CONDITIONAL WQ-144; REFACTOR WQ-145 | Claimed/dispatched/completed/failed rules preserve durable ambiguity and stale-secret safety. Dispatch preconditions and exact repeat behavior need controlled concurrency evidence, not merely sequential calls. |
| `packages/database/src/connections/workflow-integration-usage.ts` | KEEP; TEST WQ-146 | Two bounded keyset queries use scoped transactions and complete ordering tuples, with validated cursor fields. Their differing tuple shapes justify separate methods; no generic pagination abstraction needed. |
| `packages/database/src/connections/testing.ts` | KEEP | Explicit broad test capability and usage discovery exports are appropriate for fixtures and cross-domain tests. Production role surfaces remain narrower. |
| `packages/database/test/support/connections.integration.support.ts` | FIX fixture/REFACTOR WQ-146 | Owns random-named databases and finally-removes prior-head directories, but importing it runs three database setups in every suite. Partial runtime startup and swallowed shutdown failures need precise ownership. |
| `packages/database/test/connections-lifecycle.integration.test.ts` | KEEP; TEST/REFACTOR WQ-146 | Proves immutable-secret counts, snapshot replay across later rotations, provider-specific auth types and pointer FK rollback. Break independent long stories and own every checkout in finally. |
| `packages/database/test/connections-concurrency-security.integration.test.ts` | KEEP; TEST WQ-144/WQ-146 | Real same-name and same-pointer races assert one winner and no orphan version; retain. Sequential revocation/tenant denial is not the requested in-flight authority matrix. |
| `packages/database/test/connection-tests.integration.test.ts` | KEEP; TEST WQ-144; REFACTOR WQ-146 | Exact terminal replay counts and dispatched-work nonreclaim are strong. Second 200-line story contains several independent races; split without losing durable evidence. |
| `packages/database/test/connections-compatibility.integration.test.ts` | KEEP; REFACTOR/TEST WQ-146 | Populated 0036 migration preserves ambiguity rather than inventing destination credentials. Notification-policy lifecycle and two upgrade cases need their own fixture lifetimes; intentional NOT VALID FKs remain. |

## WQ-144 — qualify authority and credential ordering at dispatch admission

P2 TEST/CONDITIONAL. `connection-persistence.ts:451–495` manager/user checks
read active membership, workspace and user without holding share locks. Later
commands run in READ COMMITTED transactions. Connection RLS in 0020 scopes the
workspace; it does not re-evaluate actor role. `connection-test-persistence.ts`
markConnectionTestDispatched reads connection with selectConnection's default
lock=false, checks active/current secret, then updates idempotency and audit.
This separates eligibility observation from the durable dispatch marker.

Qualify a controlled two-session interleaving:

1. Session A passes actor/secret checks; pause before its marker update.
2. Session B rotates/revokes the credential or removes/suspends actor authority
   and commits before A resumes.
3. Observe whether A still commits dispatch evidence and the provider caller is
   allowed to proceed using the previously opened credential.

The source lacks serialization across that interval, but whether a command may
linearize at its earlier authorization read is a contract question. Pin the
existing documented revocation/dispatch guarantee first. If admission must see
the current eligible credential when the marker commits, use a stable lock order
covering claim, connection and required actor/workspace rows, or an equivalent
atomic guarded mutation. Don't add a lock to one query without checking opposite
ordering in start/resolve/complete/rotate; avoid deadlocks and preserve lock budgets.
No locks may span KMS, DNS, rate-limit waits or HTTP. An HTTP request after a
successfully admitted marker can still race later revocation; promise only the
database linearization guarantee actually established, not instantaneous recall.

Also pin and test:

- Exact repeat mark currently matches any in-progress matching token, including
  already dispatched state, and appends another dispatch audit. Decide whether
  repeat mark is idempotent or rejected; either choice must not permit duplicate
  provider calls. Add the claim state predicate/row-count or replay policy needed
  by that contract. Current normal API path invokes mark through dispatch control;
  duplicate marking is a repository-contract gap, not an observed duplicate send.
- Secret version is recorded in the audit but not the claim codec. Completion
  accepts caller-supplied secretVersionId and protects current health by comparing
  that supplied ID with the current pointer. Current caller faithfully passes the
  resolved version. If the durable boundary promises protection against a stale
  or mistaken caller, persist/check the exact dispatched version in a compatible
  claim representation. Otherwise document the trusted-caller contract. Never
  imply a public client can arbitrarily submit these repository arguments.
- Completed replay must validate workspace/connection identity if corrupted stored
  result_ref is in the fail-closed contract; creation/rotation do explicit identity
  comparisons, while parseConnectionTestResult alone proves shape. Test mismatch
  before introducing a generic replay framework.
- Preserve stale completion's audit event while preventing updates to a rotated
  or revoked current connection. Dispatched claims remain nonreclaimable merely
  due to age, and abandon may change only claimed work. Completion deliberately
  does not require actor permission to remain active after provider execution;
  do not lose outcome recording by blindly adding the admission guard everywhere.

Acceptance: deterministic lock/barrier tests prove the chosen ordering and exact
audit/provider-admission count, with every barrier released on failure. Existing
one-winner creation/rotation, replay, no-orphan and stale-completion tests still
pass. If earlier-read linearization is explicitly acceptable, KEEP the relevant
locks unchanged and document that narrower guarantee.

## WQ-145 — simplify repeated connection knowledge without flattening states

P2/P3 REFACTOR/TEST. Keep the current focused management/secret/resolution/test
implementations and one transaction owner; no broad module rewrite.

- `connection-persistence.ts` includes roughly 350 lines of public contracts then
  codecs/authorization/SQL helpers. A private contracts/codec split is justified
  only if callers stop importing implementation-heavy vocabulary and locating the
  relevant rule becomes easier. Don't split ordinary aliases into separate files.
  Preserve every public re-export through current role surfaces.
- Creation and rotation each duplicate snapshot-versus-legacy decoding between
  preflight lookup and mutation replay. Extract a named private decoder for the
  two supported persisted result shapes, then keep operation-specific identity
  validation explicit. Do not use catch-any fallback that treats a malformed new
  snapshot as successful old data. Retain exact historical snapshot results, not
  the latest connection state. Legacy pointer-only records must continue to work.
- Manager/user roles duplicate workspace-policy's connection:manage/use mapping.
  Use rolesForCapability for membership role selection where equivalent; retain
  active actor/workspace checks and not-found disclosure. Test all five roles and
  inactive statuses. This reduces drift, not the number of necessary predicates.
- Connection-test health update and standalone health update look similar but
  differ: successful test completion may restore active, standalone health keeps
  reauthorization_required, and only test completion knows the tested version.
  Do not merge them into a flag-driven helper that obscures those differences.
  First inspect real consumers: standalone recordConnectionHealth is currently
  broad testing/internal capability only. If retained, document/test its policy;
  don't claim it can safely update a current credential from any old observation.
- Mixed nested ternaries for status/event/metadata in completeConnectionTest are
  a concrete local reading cost. Prefer one private pure classification that names
  next health state, event and safe event metadata while taking current/revoked/
  tested-version inputs explicitly, or a few named local predicates. Keep provider
  outcome separate from whether it can update current health. A decision table
  should cover ok, credential rejection, other failure × same/stale × revoked.
- databaseConstraint reads unknown.code/constraint directly; if broad unknown
  containment is required, use the same safe fixed-field extraction as WQ-142.
  Do not broaden a named 23505 conflict to every constraint error or discard cause.
- Validate completed/in-progress/failed idempotency state handling explicitly.
  Create/rotate currently continue for any status other than completed; first
  establish which noncompleted statuses are reachable from their own atomic
  transactions and retained history. Treat impossible persisted combinations as
  corruption, not permission to redo an external effect.

Acceptance: current hashes/scopes, legacy decoding, historical snapshots and
tenant isolation unchanged; each extracted helper removes duplicated knowledge;
no new public seam or boolean option matrix. Tests go through public repository
methods and may use small pure codec tests for malformed stored data.

## WQ-146 — pay for historical database fixtures only where they are needed

P2 FIX fixture/REFACTOR/TEST. Importing connections.integration.support registers
beforeAll that creates/migrates current, pre-0021 and pre-0037 databases. All four
suite files import it, although only compatibility tests use historical state.
Thus lifecycle/concurrency/test-ownership suites repeat unrelated historical
migrations and notification fixture writes. This is explicit repeated work in
source, not a measured test-runtime speedup claim.

Split fixture construction by actual lifetime: current connections fixture for
ordinary tests, upgrade fixture for the two compatibility histories, and focused
notification-policy setup where needed. Avoid import-time mutable api/worker/
destinations exports; return an explicit fixture handle and register its teardown
in the owning suite. Retain the existing fixture helper for exact disposable names
and safe role grants. Don't preemptively force-drop a colliding generated name;
creation collision should fail without deleting another owner.

Register each acquired resource immediately. Current closeResources is assigned
only after three runtime factories finish, so partial construction can retain
earlier pools; Promise.allSettled also discards all close errors. Attempt all
cleanup operations, report failures, and do not drop databases while owner close
work remains unresolved. Several seed/assertion helpers connect before try; Slack
audit and policy-deletion blocks have no finally at all. Make failed checkout,
assertion and query paths release/end/drop reliably without masking primary error.

Test organization and missing evidence:

- Split safe-test ownership, abandonment/reclaim, revoked-before-resolution,
  revoked-after-dispatch, aged-dispatched refusal and rotated-after-dispatch into
  named cases. Shared builders should create valid inputs, not hide the ordering
  being tested. Keep exact credential/dispatch/success audit counts.
- Current concurrency names winnerSecretVersionId/loserSecretVersionId assume an
  outcome before the race; rename candidates A/B and derive winner from results.
  Keep the durable pointer and zero-losing-secret assertions, not only promises.
- Test exact replay after later revoke/rotate, corrupt snapshot identities, role
  changes, auth-type mismatch and failed claim paths independently. The fixture
  requestHash is deliberately supplied and may not hash every overridden input;
  these repository tests do not prove the API's request-hash construction.
- Workflow integration usage has basic discovery/cross-workspace evidence in
  workflow-authoring-publication integration (reviewed with authoring separately).
  Add complete multi-page traversal for both tuple shapes, exact final cursor
  absence, tie-break identities, invalid bounds and empty results. Preserve RLS
  scope and prepared parameters; no index change without query-plan evidence.
- Retain populated historical notification cases: pending/retry become dead-letter,
  previously dispatching stays ambiguous, missing credentials are not fabricated,
  and intentional unvalidated historical FKs still reject invalid new writes.
  Static head/suffix checks are complementary to those real data assertions.

Order: fixture safety, WQ-144 contract qualification and negative tests, then
WQ-145 selective readability changes. No database, source, migration, commit or
push changed in this review.
