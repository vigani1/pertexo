# Database run admission, replay, cancellation and events

Date: 2026-09-12. Primary reviewer fully read all 18 files below. The small
vocabulary unit suite passed (2 tests, 332 ms). Eight service-backed integration
suites and their fixture were read, not run. Source probes injected database
results and made no connection. Numbered SQL remains a separate review scope.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/execution/execution-acceptance.ts` | KEEP atomic protocol; FIX/TEST WQ-164; REFACTOR WQ-166 | Validates bounded input/checkpoint, resolves replay before new-admission authority, pins notification identity and commits claim/run/event/checkpoint/outbox together. Cause traversal is unbounded/unsafe; private replay validation mode and provider predicates can be clearer. |
| `packages/database/src/execution/execution-state.ts` | KEEP | Domain conflict and event-gap subtype give stable caller distinctions; small file is justified. |
| `packages/database/src/execution/run-events.ts` | KEEP locked append; TEST/CONDITIONAL WQ-165 | Validates safe payload, adds schema version before final 4 KiB bound, and appends sequence under caller-held run lock. Two-query read can return page metadata from a different snapshot. |
| `packages/database/src/execution/workflow-run-api.ts` | KEEP; WQ-157 extension; TEST/CONDITIONAL WQ-165 | Four methods validate inputs and propagate real transaction cancellation. Separate start/read/cancel phases preserve replay-before-current-publication behavior. Constructor validates compatibility too late; run/node read consistency needs an explicit contract. |
| `packages/database/src/execution/workflow-run-cancellation.ts` | KEEP; TEST WQ-167 | Locks run, rejects terminal state, resolves actor/reason duplicate and appends one event. Terminal-before-duplicate precedence is deliberate unless contract evidence changes it. |
| `packages/database/src/execution/workflow-run-errors.ts` | KEEP | Not-found, non-executable and bounded-read-capacity errors encode different public outcomes; don't merge by message text. |
| `packages/database/src/execution/workflow-run-persistence-support.ts` | KEEP | Shared validated run mapping, required/optional lookup and audit-after-first-acceptance remove genuine duplication. Optional audit fields remain simple, not a generic record framework. |
| `packages/database/src/execution/workflow-run-replay.ts` | KEEP | Owner-defined source/version locks retain insert-only API privileges and tenant identity. Explicit new input and immutable lineage stay distinct from an idempotent retry; reuse acceptance/audit, not manual-start selection policy. |
| `packages/database/test/execution-acceptance.test.ts` | KEEP; TEST WQ-167 | Independent canonical status vocabulary/order assertions are appropriate; two constant tests are not acceptance behavior coverage. |
| `packages/database/test/execution-acceptance.fixtures.ts` | fixture FIX/REFACTOR WQ-167 | Useful role-specific seams, exact row counts and real lock observation. Eager pools, shared global truncation/fence reset, hidden hook installation and incomplete acquisition cleanup make execution unsafe against shared services. |
| `packages/database/test/execution-acceptance-persistence.integration.test.ts` | KEEP; TEST WQ-167 | Proves actual transaction rollback, exact checkpoint hash, first durable input, byte limits, lifecycle replay and concurrent dedupe. Preserve these strong assertions when isolating the fixture. |
| `packages/database/test/execution-acceptance-security.integration.test.ts` | KEEP; fixture FIX WQ-167 | Exact RLS/table/column grants and live denial are valuable; trigger drift must occur only in owned databases and restoration failure must not be swallowed as success. |
| `packages/database/test/execution-acceptance-regional.integration.test.ts` | KEEP; fixture FIX WQ-167 | Verifies new admission fails while exact replay survives the fence and worker role works. Mutates singleton regional state and leaves it paused until another reset; isolate rather than restore a guessed shared state. |
| `packages/database/test/execution-acceptance-capacity.integration.test.ts` | KEEP; TEST/REFACTOR WQ-167 | Real 101-to-100 queued admission, active slots, dispatch reservation/recovery/fairness and counter repair are meaningful. Long mixed dispatch story and one-second entitlement setup window obscure failures and risk flakes. |
| `packages/database/test/execution-acceptance-notifications.integration.test.ts` | KEEP; fixture FIX/TEST WQ-167 | Real disable/rotation lock observations prove pin timing; invalid pin matrix is useful. Initial acquisitions/PID queries and unobserved pending acceptance can escape teardown; scope NO FORCE RLS fixture construction honestly. |
| `packages/database/test/execution-acceptance-lifecycle.integration.test.ts` | KEEP; fixture FIX/TEST WQ-167 | Exercises both lock winners and deletion's durable cancellation. Barrier setup before try can leave admission held if acquisition/PID observation fails. |
| `packages/database/test/workflow-run-api.integration.test.ts` | KEEP; fixture FIX/TEST WQ-167 | Atomic API audit/outbox, selected retained replay version, cross-tenant hiding and downstream-constraint rollback are genuine proofs. Global TRUNCATE and pre-try two-client acquisition need isolation/ownership; add nonempty read and cancellation branches. |
| `packages/database/test/run-events.integration.test.ts` | KEEP; fixture FIX/TEST WQ-167 | Real gap rejection and post-versioning exact byte limit are valuable. Global execution/audit TRUNCATE is not a tenant-scoped reset. Add concurrent append and page metadata cases. |

## WQ-164 — bound admission-error inspection and preserve the original failure

P2 FIX/TEST. execution-acceptance.ts:141–152 traverses `while (current instanceof
Error)` and reads code/cause without guarding access or tracking visited values.
A source-injected ordinary Error with a throwing cause accessor escaped as the
accessor's secondary Error instead of the original database failure. No real
driver, query or provider operation ran. Cyclic cause traversal is also structurally
unbounded; no production cyclic driver error is claimed.

Use a small guarded, bounded, cycle-aware inspection rule, preserving the original
unknown rejection when classification cannot be completed. Recognized admission
codes must retain existing stable public errors and bounded retry hints; optional
private cause retention must not leak raw SQL/configuration through the API.
Test direct/nested PTA01/PTA02/PTA03, unrelated code, primitive/undefined, cycle,
throwing code/cause accessor and proxy rejection. Do not build a global error
hierarchy just to replace this local loop.

Scope SQLSTATE interpretation to its operation. PTA03 is used both for regional
write admission and active-slot rejection in different SQL paths; this function
inserts queued runs, while active transition tests expect the latter. Do not
globally map every PTA03 in the repository to regional pause or rewrite historical
SQLSTATE contracts during a readability refactor. Any encountered ambiguity needs
an operation-specific regression before changing its external error.

## WQ-165 — specify snapshot consistency for run reads and event-page metadata

P2 TEST/CONDITIONAL. readRunModel at workflow-run-api.ts:407–433 reads run and
node rows in separate READ COMMITTED statements. A coordinator commit between
them can produce an older run header with newer node states. readRunEventsAfter
at run-events.ts:146–193 reads maximum sequence and page separately, without an
upper bound tied to that maximum. An injected source probe returned highWater=1
and a page ending at sequence 2, illustrating the allowed result shape under
inter-statement insertion; this is not a live two-client reproduction.

The current API SSE reader uses page.events and ignores highWaterSequence, so
this result alone does not establish lost events or a broken SSE cursor. Decide
whether the exported read model promises one snapshot or explicitly permits mixed
observations. If a snapshot is required, use one composed SQL statement or the
existing repeatable-read, read-only ownership semantics at an appropriate seam.
Avoid adding run-row write locks to all reads; assess retention interaction and
latency before introducing additional locking. For an intentionally weak read,
document what highWater means and keep consumers from treating it as the page's
upper bound. A cosmetic max(highWater,lastEvent) does not make run/node state
consistent or repair retention gaps.

Add coordinated insertion/transition/retention cases, empty/tail/middle pages,
limit and hasMore boundaries, gap detection and cursor beyond current history.
Measure the grouped max-sequence query on representative retained histories;
consider an indexed maximum or stored cursor only with explicit write ownership
and retention semantics. No performance defect is asserted without that evidence.

## WQ-166 — name replay-validation modes and notification pin eligibility

P2/P3 REFACTOR. readExistingAcceptance at execution-acceptance.ts:265–335 takes
initialCheckpointHash plus a default-true verifyInitialCheckpointHash flag.
readWorkflowRunAcceptanceReplay calls it with undefined,false; direct acceptance
and conflict reread require exact initial checkpoint identity. Preserve the two
contracts, but make the private call intent explicit:

```ts
type ReplayValidation =
  | { kind: 'request_only' }
  | { kind: 'exact_initial_checkpoint'; hash: string };
```

This is a private readability option, not a required public type redesign. Keep
replay before current release/publication/lifecycle/admission checks, first durable
input preservation, missing/incomplete-row corruption detection, and concurrent
conflict reread. The acceptance schema intentionally trusts the caller's canonical
requestHash; tests holding that hash constant with different inputs prove first
write retention, not independent input equivalence. Document that caller contract.

Notification pin predicates at 192–239 duplicate destination-kind discrimination
across side-effect and connection-provider checks. A small explicit provider
requirements table or named private predicates may improve locality, preserving
email/idempotent and Slack/unsafe pairings, absence/disabled behavior, share locks
and exact retained secret version. Do not turn missing/disabled optional policy
into failed run admission unless the policy contract explicitly changes. Keep
the ordered SQL pinning phases and no external decryption inside the transaction.

WQ-157 also applies to workflow-run-api.ts:220–228: parse release input before
acquisition, retaining borrowed runtime ownership. Simple signal/optional-field
forwarding and separate replay/cancellation modules are otherwise KEEP.

## WQ-167 — isolate destructive fixtures and complete run behavior evidence

P2 TEST/fixture FIX. execution-acceptance.fixtures.ts:169–246 truncates execution,
workflow, notification and purge state on the configured database and resets the
regional singleton. workflow-run-api.integration.test.ts:187–283 truncates users,
workspaces and workflows too. run-events.integration.test.ts:40–78 truncates shared
execution/audit tables. A workspace GUC does not scope TRUNCATE. Route all through
explicit disposable database ownership before routine parallel/local execution;
retain runtime role separation and exact schema qualification.

Move eager constructors under setup, guard every successful acquisition before
the next acquisition/PID query, and attempt every owned close. Release barriers
and settle observed pending queries on failure. In lifecycle tests, admissionLocked
must race/observe admission failure so a rejection before signaling cannot strand
the test; protect the hold from its creation, not only after opening the deletion
client. Notification rotation/disable tests must observe acceptance immediately
and await its settlement if lock observation fails. Keep pg_blocking_pids evidence:
it is stronger than sleep-based guesses. Apply WQ-150 to failed rollback disposal.

The entitlement-expiry case creates expiry at database now+1 second, performs
several operations, then sleeps 1.1 seconds. This preserves a real immutable
expiry test, but admission can miss the initial window on a slow machine. Give
setup a safe bounded window, assert acceptance precedes expiry, and wait against
the persisted database timestamp with an overall deadline. Do not fake a different
clock or mutate immutable entitlement data to make the assertion pass faster.

Keep security fixture NO FORCE RLS changes inside their transaction with FORCE
restored before commit; they are fixture construction, not evidence that normal
actor writes can insert the same rows. Prefer existing authorized creation seams
where they can construct the required valid state. Drift tests should assert
restored readiness and surface failed restoration, never silently leave altered
shared security. Bound cause-chain test helpers as in WQ-164.

Missing focused cases: cancellation wrong actor/reason duplicate, terminal
precedence, no reason, exact event/audit/outbox counts; get with nonempty nodes,
resume/retry mapping, 1000 versus 1001 nodes; concurrent event append returns
consecutive identities; read page limits/gaps and WQ-165 consistency; acquisition/
signal/close lifecycle; malformed completed idempotency records; admission
classification matrix. Retain real post-acceptance and downstream-constraint
rollback proofs—unlike early rejection, these genuinely exercise rollback after
writes. Separate the long dispatch reservation/fairness/recovery story into named
scenario helpers or focused cases without weakening cross-step invariants.

Implementation order: fixture isolation and WQ-164/constructor regressions;
WQ-165 contract and concurrency qualification; WQ-166 private cleanup after
behavioral coverage. No source edits, migration applications or services occurred.
