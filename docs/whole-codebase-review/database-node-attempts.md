# Database production node attempts

Date: 2026-09-12. Primary reviewer fully read these 12 files, including the
1,380-line integration suite. No service-backed test ran. Existing coordinator,
For Each, pending-failure and bounded-work evidence is cross-referenced rather
than counted again. ADR-007 is the behavior authority.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/execution/node-attempt-run-store.ts` | KEEP | One leased pool behind five meaningful operations; forwarding functions keep implementation private without exposing a generic SQL interface. |
| `packages/database/src/execution/node-attempt-run-store-contract.ts` | KEEP; TEST WQ-187 | Validated delivery, owned lease and discriminated outcome distinguish real stages. Limits and typed errors are useful. Add operation-level malformed identity/scope/lease matrices, not another validation framework. |
| `packages/database/src/execution/node-attempt-run-store-transactions.ts` | KEEP; TEST WQ-187 | Delegates cancellation and transaction ownership to the existing tenant engine. Read-only input loading is appropriate. Scoped key encoding duplicates an established durable format and must remain byte-compatible. |
| `packages/database/src/execution/node-attempt-run-store-delivery.ts` | KEEP | Canonical payload checksum, exact aggregate identity and locked inbox receipt are distinct checks. Mismatch auditing commits after business rollback; do not move its public throw into that transaction. |
| `packages/database/src/execution/node-attempt-run-store-claim.ts` | KEEP; REFACTOR WQ-186 | Receipt, run and node/attempt lock order protects one claim and event sequence. Running live duplicate differs from expired reconciliation; prior unresolved dispatch evidence must survive retries. Nested optional scope projection is localized readability work. |
| `packages/database/src/execution/node-attempt-run-store-inputs.ts` | KEEP; CONDITIONAL WQ-186; TEST WQ-187 | One consistent snapshot, scoped upstream whitelist, batched outputs and nearest-loop checksum proof are substantive. Repeated loop/path serialization may be indexed locally only if measured. Do not remove ancestry, cardinality or node/attempt output equality checks. |
| `packages/database/src/execution/node-attempt-run-store-dispatch.ts` | KEEP; TEST WQ-187 | Connection/version fence and immutable binding precede a live-owner attempt update in one transaction; binding writes roll back on failed attempt ownership. Cancellation is cooperative for already admitted work, not permission to overwrite truthful provider results. |
| `packages/database/src/execution/node-attempt-run-store-heartbeat.ts` | KEEP | Database expiry, owner, token and current attempt checks fence renewal; cancellation takes precedence over deadline in returned control reason. Explicit SQL conditions represent independent identity checks. |
| `packages/database/src/execution/node-attempt-run-store-completion.ts` | KEEP; TEST WQ-187 | Validates bounded output before transaction, checks delivery/receipt, locks run and physical attempt, then delegates outcome application. Suspension under active control is specifically denied; successful effects remain truthful. |
| `packages/database/src/execution/node-attempt-run-store-outcomes.ts` | KEEP phase separation; REFACTOR WQ-186; TEST WQ-187 | Duplicate, active lease, attempt persistence, suspension and terminal paths have distinct roles. Executor failure deliberately leaves logical-node decision to coordinator. Repeated discriminator ternaries and suspension cast can be simplified privately. |
| `packages/database/test/node-attempt-run-store.test.ts` | KEEP assertions; TEST WQ-187/WQ-185 | Canonical identity and already-aborted admission checks are useful, and finally closes the store. Creating a default monitored real pool means the title alone does not prove zero PostgreSQL activity. |
| `packages/database/test/coordinator-run-store-node-attempts.integration.test.ts` | KEEP behavior evidence; REFACTOR/TEST WQ-187 | Durable stale token, unknown-evidence reconciliation, provider rotation, exact completion, upstream reads and Wait resume are valuable. The 500-line mixed claim case obscures independent failures and temporarily mutates shared workspace status without finally restoration. |

## WQ-186 — make outcome projection explicit without fragmenting transactions

P2 REFACTOR, with a P3 conditional input-lookup improvement. Exact locations:
outcomes.ts completionFields:54–79, applyNodeAttemptCompletion:330–368;
claim.ts lease projection:228–263; inputs.ts selectStructuredLoopDeclarations:121–149.

Current durable status selection repeats the public outcome discrimination:

```ts
executorOutcome !== undefined
  ? 'failed'
  : input.outcome.status === 'suspended'
    ? 'succeeded'
    : input.outcome.status
```

Prefer an exhaustive switch inside completionFields that returns the existing
four fields for succeeded, suspended, executor_failure and ordinary terminal
failures. Keep their exact null conventions. Pass the narrowed suspended outcome
separately to commitSuspension instead of casting the entire CompletionInput to
an intersection. Retain the current private phase layout and public interface;
do not introduce a class hierarchy or a generic state-machine DSL.

Normalize optional nonempty branch/iteration arrays to local variables before
constructing the claim lease. This removes repeated optional chains and mixed
undefined/empty tests without changing omission semantics or persisted scope.

For structured-loop selection, each ancestry level filters all checkpoint loops
and serializes both paths repeatedly. First measure upper supported nested-loop
input. If material, precompute canonical ancestry keys once per load and retain
the exact branch-prefix and active-ordinal predicates, including the requirement
for exactly one match. No global cache, format change or claim of measured
latency improvement. KEEP the current loop if the measurement does not justify
an index. Existing upstream SQL already batches at most 100 descriptors.

Acceptance: public completion tests preserve each durable status, node mutation
or deliberate non-mutation, pending retry tuple, output/error null fields,
outbox/receipt count and rollback. Root omitted scope and empty scope produce
the same returned lease shape. Loop tests retain nested ancestry, sibling/parent
branch rejection, checksum, ordinal and matching node/attempt output proof.

## WQ-187 — isolate attempt tests and make replay/ownership assertions exact

P2 TEST/REFACTOR. First split integration test `claims one transport-bound ready
attempt with a durable fence` (around lines 372–915) into independently seeded
claim, connection fence, completion/replay, and downstream-value cases. Generalize
the existing claimDispatchAttempt helper with explicit side-effect/input options;
do not silently add outbox rows to fixtures that claim to prove zero writes.
Move workspace suspension/restoration into try/finally or use a dedicated
workspace. Keep the HTTP/Slack table: these really are the same fence contract.

Replace the real port-1 pool in the no-work unit checks with an injected runtime
whose checkout is counted/rejected, and disable monitoring for that fixture.
The operation must reject before checkout, not merely before a successful query.
Extend this matrix to load, dispatch, heartbeat and complete, with otherwise
valid inputs so each intended guard is actually reached.

Add focused durable replay and ownership scenarios:

- Current fence with expired lease, changed owner, wrong current attempt, and
  isolated changed token; assert no output/node/event/outbox/receipt mutation.
- Exact and changed output/error/failure-kind/possibly-dispatched completions;
  pending executor decision versus already-decided node state.
- Suspension replay before and after run control or later resume. Current
  duplicate comparison omits durationSeconds, and a control check precedes the
  duplicate path. Explicitly settle whether these are semantic duplicates of an
  already fixed wait or mismatched replay; do not add a new stored field or
  silently recompute resume_at without an agreed contract. This is a TEST/
  contract clarification, not a proven duplicate-effect defect.
- Inject failure after attempt update and after outbox insert, proving the
  transaction rolls back everything. Check exact committed security-audit count
  separately after a delivery mismatch.
- Independently specified scoped invocation-key examples for root, colon-bearing
  identifiers, branch and nested iteration, shared with engine compatibility
  expectations without computing expected strings using the subject function.

The Wait case intentionally crosses database time, but a one-second wait can
expire during setup before its early-scan assertion. Use a comfortably future
immutable deadline and bounded polling against database time, or a purpose-built
fixture for the early/non-early halves. Do not mutate immutable checkpoint time
or replace PostgreSQL time with a fake JavaScript clock. Assert the specific
scanner delivery identity rather than counting hidden helper-created outboxes.

Order: repair fixture ownership (WQ-185), add these focused cases, then perform
WQ-186. No changes to attempt truth, retry ownership, lease authority or scope
encoding are justified merely by reducing the number of conditions.
