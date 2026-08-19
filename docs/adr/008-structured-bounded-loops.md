# ADR 008: Structured bounded loops and deterministic joins

- **Status:** accepted
- **Date:** 2026-08-20

## Context

The workflow engine must support branches, fan-out, and repetition without
making recovery depend on canvas position, completion order, worker memory, or
unbounded graph traversal. General graph cycles and race-based joins would make
the ready set and provider-side-effect history ambiguous after a crash.

## Decision

Published workflow graphs are directed acyclic graphs. Publish validation
rejects every back-edge and strongly connected component with more than one
node, including cycles that cross a structured-body boundary. Repetition is
available only through a `For Each` node that owns one explicitly scoped body.
The body is validated as a DAG, has declared input and output ports, and cannot
be entered or exited by an ordinary graph edge. Future loop forms, including
`While`, require a separate bounded definition; they cannot be represented by
back-edges.

Each `For Each` definition declares positive integer `maxIterations` and
`maxConcurrency` values. `maxConcurrency` cannot exceed `maxIterations` or the
platform safety cap. The normalized published version records those values, and
its worst-case expansion, including nested structured bodies, must fit that
cap. Run admission also checks the workspace entitlement, whose initial V1
run-wide loop-iteration limit is 1,000, and resolves the effective iteration
and concurrency limits. If the published declaration exceeds either limit,
admission rejects the request without creating a run. Otherwise, the accepted
run pins that limit snapshot so a later entitlement change cannot alter
recovery.

The loop evaluates its collection once from canonical input and records its
size plus the inline-value checksum or artifact reference in durable scheduler
state. If the collection exceeds the pinned maximum or run-wide iteration
budget, the loop fails with a typed limit error before admitting any iteration;
it never truncates input. Iterations use stable zero-based ordinals from the
canonical collection order. Only a bounded batch may be ready or running at
once, and each later batch is admitted by a checkpoint compare-and-swap after
earlier durable outcomes are observed.

Every logical node invocation has a canonical scope made from the ordered path
of branch identifiers and loop-node/iteration-ordinal pairs from the workflow
root to that invocation. Its `invocationKey` is derived from the immutable
workflow-version identity, node ID, and canonical scope. Keys never contain a
worker ID, attempt number, queue job ID, timestamp, or completion ordinal.
Retries reuse the logical invocation key; a replay is a new run and therefore a
new invocation namespace. Uniqueness of `(workflow_run_id, invocation_key)`
prevents duplicate deliveries from creating another logical invocation.

Fan-out records a branch ledger keyed by stable branch IDs from the immutable
version. Each declared branch has an explicit persisted disposition:
`pending`, `arrived`, `skipped`, `missing`, `failed`, or `canceled`. `skipped`
means the scheduler proved the branch unreachable; `missing` means the branch
was declared for the join but produced no invocation or output. Neither state
is inferred from absent rows. Branch outputs remain keyed by source node and
output port.

Joins declare exactly one policy:

- `all` becomes terminal only when every declared branch has a terminal
  disposition; it succeeds when none failed or were canceled and exposes the
  complete keyed ledger, including explicitly absent skipped and missing
  branches;
- `any` requires one arrived branch; and
- `count(n)` requires a positive bounded number of arrived branches no greater
  than the declared branch count.

Every join waits until all declared branches have an explicit terminal
disposition. For `any` and `count(n)`, qualifying branches are then selected by
canonical branch ID order, never arrival order. If the settled ledger cannot
satisfy the policy, the join fails with a typed unsatisfied-join result rather
than waiting forever. The persisted join result contains the policy, selected
branch IDs, and the complete declared branch ledger. Duplicate completions
cannot revise the selected set or schedule the join again.

The checkpoint serializes only bounded, versioned scheduler facts needed to
reconstruct execution: the canonical ready set, admitted invocation keys,
branch ledgers and selected join sets, loop collection references and sizes,
iteration cursors and terminal ordinals, remaining run-wide iteration budget,
and durable output references. Collections and node outputs are not duplicated
inline beyond the platform payload limit. Ordering is canonical before hashing
or persistence, and checkpoint data contains no process-local handles, timers,
promises, or Redis/BullMQ state.

A coordinator loads the immutable version, current checkpoint, and persisted
run/node outcomes, computes one transition plan, and commits it with the
checkpoint revision compare-and-swap defined by ADR 006. A stale coordinator
reloads and recomputes. A fresh worker must reconstruct the same ready set,
scopes, join selection, and loop cursor after any pre- or post-commit crash.
Malformed, unsupported-version, over-limit, or internally inconsistent
checkpoint state fails closed with a typed operational error; the engine never
guesses from canvas order or output presence. Durable cancellation preserves
already recorded dispositions and prevents admission of new branches or
iterations.

## Consequences

Branch, join, and loop recovery is deterministic under worker crashes,
duplicate completions, and Redis loss, and fan-out remains bounded by explicit
published and run-pinned limits. The trade-off is a more explicit published
graph format, branch ledger, checkpoint schema, and validation pass. `any` and
`count(n)` wait for all declared branch dispositions before selecting their
canonical result, favoring reproducibility over race-dependent latency.

Phase 0E must prove these rules with an executable fixture covering arbitrary-
cycle rejection, skipped and missing branches, all three join policies,
iteration/concurrency limits, duplicate completion, and coordinator crashes on
both sides of checkpoint commit. This ADR does not pass the custom-engine gate
by itself; the fixture and measured recovery evidence remain required by ADR
005.
