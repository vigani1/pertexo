# ADR 020: Bounded For Each iteration and structured-body execution

- **Status:** accepted
- **Date:** 2026-08-24

## Context

ADR 008 requires deterministic bounded loops, but it does not define the V1 For
Each node contract, how a structured body receives its current item, when the
run-wide iteration budget is consumed, or what the parent node exposes after
the body completes. Those choices must remain deterministic for nested loops,
duplicate outcomes, cancellation between batches, and fresh-worker recovery.

## Decision

### Node and body contract

`core.for_each@1` is a `logic`, `cpu`, `safe` node under executor ABI 1. It has
one `in` port and one `out` port, strict `{}` config, strict input
`{ items: JsonValue[] }`, and strict output
`{ items: JsonValue[], iterationCount: integer }`. The executor performs no
mapping or traversal: it returns the validated items unchanged with their exact
length. The ordinary node JSON byte, depth, and member limits bound both input
and output; larger collections must be represented by an upstream artifact and
reduced to a bounded collection before For Each.

The node must own exactly one `structured.kind: "for_each"` body. Its declared
positive `maxIterations` and `maxConcurrency` are immutable executable fields;
concurrency cannot exceed iterations or the platform cap. The body is a
non-empty DAG isolated from ordinary outer edges, has exact input ports `item`
and `ordinal`, and one output port `result`. Every body node must be reachable
from a body root and able to reach the one canonical sink. The complete output
of that sink is the iteration result. All body definitions, executors, policies,
edges, mappings, limits, and nested structures are pinned into executable
identity.

Body mappings gain one source kind,
`{ kind: "structured_input", port: "item" | "ordinal", path: string }`. It is
valid only inside a structured body and resolves against the nearest enclosing
iteration. `item` is the value at the stable collection ordinal and `ordinal`
is its zero-based integer. Ordinary `run_input` continues to mean the outer run
input, so nesting does not silently change existing mapping semantics. A nested
For Each receives its collection through ordinary outputs produced in its
enclosing iteration and has its own nearest structured input.

For Each does not aggregate body results into its node output. Per-iteration
sink outputs remain durable and inspectable by scoped invocation key, while the
parent exposes the original bounded collection and iteration count. This avoids
duplicating as many as 1,000 body outputs into one node value. A future aggregate
or reduce node requires a separately bounded contract.

### Scheduling and identity

After the For Each declaration attempt succeeds, the coordinator verifies its
exact persisted output, computes the canonical collection checksum, and starts
the loop in the same checkpoint transition. The logical For Each control enters
`waiting` without retaining a worker slot. Zero items complete it immediately.
For a non-empty collection, downstream outer nodes remain blocked until every
required body invocation succeeds or is explicitly skipped. The coordinator
then marks the control succeeded while preserving its declaration output. Any
unhandled body failure, timeout, cancellation, or unknown outcome terminates the
control consistently and prevents admission of later ordinals.

Iterations use canonical collection order and stable zero-based ordinals.
`maxConcurrency` counts active iteration scopes, from first body-root admission
until that iteration becomes terminal; it does not bypass the run or workspace
attempt-admission caps. A checkpoint transition admits the next canonical batch
only after durable terminal facts free iteration capacity. Completion order
cannot change later ordinal identity or admission order.

Every body invocation appends `{ loopNodeId, ordinal }` to its ordered
`iterationPath`; nested loops append rather than replace that path. Its
invocation key uses the immutable workflow version, globally unique body node
ID, branch path, and complete iteration path. Loop state is keyed by the exact
scoped For Each control invocation key, not only its node ID, because one nested
For Each node can execute once per enclosing ordinal. Retries reuse the same
logical key, and uniqueness of `(workflow_run_id, invocation_key)` makes
duplicate admission and outcomes inert.

### Limits, durability, and rollout

Publication computes both worst-case total loop iterations and expanded body
invocations, including nested products, and rejects either above its platform
cap. Run acceptance pins the workspace iteration entitlement; V1 permits at
most 1,000 total iterations. When a collection is declared, its entire size is
reserved atomically from the remaining run budget before any body root is
admitted. If the collection exceeds `maxIterations` or the remaining budget,
the loop fails with a typed limit result and admits zero iterations. Budget is
never partially consumed, refunded, or recalculated from queue state. When
multiple scoped loops become declarable together, canonical invocation-key
order determines reservation.

Checkpoint V2 persists the scoped control key, collection output reference and
checksum, collection size, pinned bounds, next ordinal, active ordinals,
terminal ordinals, complete iteration paths, and remaining run budget.
PostgreSQL and checkpoint compare-and-swap remain authoritative; BullMQ carries
only reconstructable delivery hints. Cancellation preserves terminal outcomes,
cancels ready or waiting body work through normal state transitions, and admits
no later batch. A fresh coordinator reconstructs the same item, ready batch,
cursor, and nested scope after crash or Redis loss. Mismatched collection
material, checksum, scope, budget, body topology, or duplicate terminal outcome
fails closed.

For Each uses additive staged and active compatibility releases. It remains
outside serving cohorts until exact/over-limit and nested-expansion tests,
bounded-concurrency and cancellation-between-batches tests, duplicate and
pre/post-checkpoint crash tests, and PostgreSQL/BullMQ fresh-worker recovery all
pass.

## Consequences

The loop remains bounded before execution and deterministic during recovery,
including when nested. Full-budget reservation prevents a collection from
partially running before a late limit failure. Explicit structured input avoids
overloading outer run input. The trade-off is that V1 For Each is a completion
barrier rather than a result aggregator; consumers needing collected results
must use a future explicitly bounded aggregate contract.

## Rejected alternatives

- Permit arbitrary back-edges or ordinary edges across a body boundary.
- Reinterpret `run_input` as the current item inside a body.
- Key nested loop state only by For Each node ID.
- Consume the run-wide budget one batch at a time and fail after partial work.
- Truncate collections at either the node or run limit.
- Define concurrency as unbounded body attempts rather than active iterations.
- Aggregate every body output into the parent For Each output.
- Use queue jobs, completion order, or worker memory as the loop cursor.
