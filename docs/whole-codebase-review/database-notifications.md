# Database failure notification delivery and configuration

Date: 2026-09-12. Primary reviewer fully read the nine files below, plus the
already-reviewed acceptance notification integration and worker call sites.
Completion unit suite: 12 tests passed (311 ms). An actual-source probe used an
injected pool/client only: NaN maxAttempts produced a dead-letter write and a
negative retry delay reached the scheduling SQL. No PostgreSQL/provider service
was contacted; this does not prove acceptance by production SQL constraints.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/execution/failure-notification-contracts.ts` | KEEP; TEST WQ-178/180 | Ready versus busy/terminal and Slack/email destinations are useful variants. Signals and owned close are explicit. Numeric TypeScript annotations alone do not validate completion input. |
| `packages/database/src/execution/failure-notification-errors.ts` | KEEP | Stable state-error identity is a small intentional import boundary; no new error hierarchy needed. |
| `packages/database/src/execution/failure-notification-destination-errors.ts` | KEEP | Three public error codes make conflict/idempotency/not-found mapping explicit. Separate file avoids importing repository implementation for transport error handling. |
| `packages/database/src/execution/failure-notification-store-support.ts` | KEEP; TEST WQ-180 | Intent-namespaced deterministic attempt outbox IDs, canonical checksum and same-client audit keep scheduling atomic. Independent SQL uniqueness remains authority. |
| `packages/database/src/execution/failure-notifications.ts` | KEEP fenced claim/recovery; TEST WQ-178/180 | Validates queue identity/checksum, locks intent, respects retry due time and carries pinned credentials/history. Terminal/busy guards have distinct effects; do not collapse them. Recovery bounds are explicit. |
| `packages/database/src/execution/failure-notification-destination-store.ts` | KEEP pin/current-authority checks; TEST WQ-178/180 | Credential access is audited and dispatch is fenced separately against current status/secret and stable binding. Loading a pinned secret alone must never authorize a later provider call. |
| `packages/database/src/execution/failure-notification-completion-store.ts` | KEEP decision helpers; FIX/TEST WQ-178/180 | Existing named retry/terminal decisions are clearer than nested ternaries. Locked attempt check and atomic update/outbox/audit preserve stale-worker safety. Completion numeric inputs lack the claim/recovery validation. |
| `packages/database/src/execution/failure-notification-destinations.ts` | KEEP transaction/authorization; FIX/REFACTOR WQ-179; TEST WQ-180 | Reauthorizes before idempotent replay, freezes historical version results and serializes append/status. Workflow policy audit events use the wrong target type. Generic read/map names and repeated command phases can be made more local without a public framework. |
| `packages/database/test/failure-notification-completion-store.test.ts` | KEEP policy matrix; TEST WQ-180 | Twelve named policy/invalid-predispatch cases check key transitions. Transaction/outbox/audit are mocked; no atomicity claim follows. Missing stale/rollback/parameter/binding evidence and an impossible-state-looking unsafe-history fixture need clarification. |

## WQ-178 — validate completion timing and attempt controls at the database seam

P2 FIX/TEST. failure-notification-completion-store.ts:94–105 parses identity and
delivery result but not attemptNumber, maxAttempts or retryDelaySeconds. The
decision at :75 compares against the raw maximum and :143 forwards the raw delay.
By contrast failure-notifications.ts:60–68,105–119 rejects invalid recovery and
claim controls. Direct injected-client calls to completeDelivery returned
completed and selected dead_letter for maxAttempts=NaN, and passed -5 seconds to
retry scheduling for an otherwise valid first-attempt retry.

The production maintenance composition currently supplies maximum 3 and delay
30, and claim validates its maximum first. This is a callable boundary and
consistency defect, not an asserted currently reachable public HTTP exploit or
a demonstrated live-database corruption. Reject invalid controls before pool
checkout. Reuse private maximum-attempt validation, bound attemptNumber to the
established persisted attempt domain, and give retry delay a documented bounded
safe-integer policy. Existing integration callers use zero for terminal completion,
where delay is unused; preserve that case and require a positive delay when a
retry is actually scheduled, or explicitly document supported immediate retries.
Do not reject an existing terminal call merely to standardize a helper.
Validate attemptNumber for
loadDestination/fenceDispatch too; do not convert malformed input into a normal
stale outcome through SQL coercion. Preserve genuine stale-attempt no-ops.

Acceptance: independent negative/fractional/NaN/infinity/out-of-range cases and
zero where invalid for that parameter cause no checkout, read, write, audit or
outbox insertion; test the terminal zero-delay compatibility case separately;
valid boundary values retain current retry/terminal behavior. Use the current
transaction helper and delivery result schema, not a new validation framework.

## WQ-179 — correct audit target identity and clarify destination command phases

P2 FIX, P3 REFACTOR. failure-notification-destinations.ts:296–322 hard-codes
target_type='failure_notification_destination'. Both policy operations at
:567–575 and :621–629 pass workflowId as targetId. Thus workflow policy audit
records pair a workflow UUID with a destination target type. Make target kind
explicit in the private audit input, using the existing workflow target convention
for policy changes and destination type for destination changes. Preserve action,
actor/request/trace metadata and transaction atomicity. No historical audit
rewrite is authorized or implied; any later correction policy needs a separate
explicit decision.

Rename private map/read/serialize to destination-specific names if touching this
module. Replace destination.* in read/list with their actual projected columns
to make the contract visible. The repeated sequence is authorization → claim
or replay → operation-specific lock/validation/mutation → audit → complete.
Keep that visible. A small private claimed-command helper is conditional on
reducing repetition without hiding authorization-before-replay or changing lock
order. Seven domain methods are not grounds for seven new repositories/files.
Retain append-version optimistic checks and immutable historical replay; do not
return the latest destination instead of the original result.

## WQ-180 — strengthen notification evidence at the real boundaries

P2 TEST. Completion unit tests currently inspect selected positional SQL values
and whether outbox was called, but do not assert audit values or exact next
attempt/availableAt. Add named cases for missing/terminal/older/newer attempts
(no mutation), delivered provider-reference persistence, definite failure,
retry/outcome-unknown at exhaustion, historical uncertainty and invalid claims.
Cross side-effect class with dispatch state only for reachable combinations;
the existing claimed unsafe row with prior uncertainty should be explicitly a
corrupt-state defensive policy test or replaced by a reachable fixture. Do not
present it as normal safe replay of an uncertain unsafe effect.

Keep helpers private and test through completeDelivery. Mocked transaction work
cannot prove rollback: add isolated-database failure injection after intent update,
outbox insert and audit insert to assert all-or-nothing persistence. Include signal
before checkout/during operation and commit-ack uncertainty without retrying an
already possibly committed completion as if nothing happened.

Claim/destination evidence should independently vary queue job/aggregate/schema,
stored versus supplied checksum, corrupt context, due boundary, terminal/busy,
attempt ceiling, pinned version, current credential rotation/revocation, destination
disable, wrong provider/auth type and exact binding replay. Coordinate destination
changes against dispatch locks; acceptance-time locking tests do not prove this
later boundary. The scheduling integration already checks pinned configuration,
credential rotation, disabled destination loading and a disable/fence race; extend
its coverage and replace its sleep-based overlap inference, not duplicate it.
Verify secret-access audit has only stable identifiers, not sealed
bytes, recipient or provider response. Preserve the existing worker integration
tests and their separately recorded fixture improvements (WQ-118–119).

Destination commands need actual repository tests for every role and inactive
actor/workspace, same-key same-request historical replay, different-request
conflict, concurrent optimistic append, status no-op policy, workflow visibility,
policy clear no-op and audit target identity. API controller mocks do not establish
database authorization or idempotency. Validate record/replay kind agrees with
config kind under malformed-row tests; map currently lets stored.kind override
its initially supplied kind, while credential resolution supplies canonical kind
last. Qualify SQL constraints before alleging a reachable conflicting-kind row.

Implementation order: numeric regression and audit identity fix; strengthen
public-method tests and isolated transaction evidence; only then private naming
and command-phase cleanup. Preserve pinned delivery and unresolved-dispatch truth.
