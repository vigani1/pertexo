# ADR 019: Bounded Parallel fan-out and deterministic Merge

- **Status:** accepted
- **Date:** 2026-08-24

## Context

ADR 008 fixes durable branch ledgers and deterministic join policies but does
not define the V1 Parallel and Merge node contracts, topology pairing, or which
limit controls concurrent branch admission. Condition and Switch cannot serve
as fan-out because they select exactly one branch, and ordinary DAG convergence
is rejected until a Merge can make every absent or failed branch explicit.

## Decision

### Parallel contract

`core.parallel@1` is a `logic`, `cpu`, `safe` node under executor ABI 1. It has
one `in` port and sixteen fixed output ports named `branch-01` through
`branch-16`. Its strict config is
`{ branches: { id: BranchPort }[], maxConcurrency: integer }`, with two through
sixteen unique branch IDs and `maxConcurrency` between one and the declared
branch count. Its strict input is `{}` and output is
`{ branchIds: BranchPort[] }`. The executor returns the configured IDs in stored
array order without graph traversal or expression evaluation.

Branch identity is the explicit output-port ID, never array index, edge order,
canvas position, admission order, or completion order. Publication requires at
least one outgoing edge for every declared branch and rejects edges through
undeclared branch ports. Descendants reached from distinct branches may first
reconverge only at the one paired Merge.

After the Parallel attempt succeeds and its exact persisted output is verified,
the coordinator creates all declared scoped branch roots as ready facts in one
checkpoint CAS. Attempt admission remains bounded by the minimum of the pinned
Parallel `maxConcurrency`, the run admission cap, and workspace capacity. A
ready branch does not consume capacity until an attempt is admitted. Durable
cancellation preserves existing outcomes and prevents new branch admissions.

### Merge contract and pairing

`core.merge@1` is a `logic`, `cpu`, `safe` node under executor ABI 1. It has
sixteen fixed input ports matching the Parallel branch ports and one `out` port.
Its strict config is
`{ parallelNodeId: NodeId, policy: { kind: "all" | "any" } | { kind: "count", count: integer } }`.
The referenced Parallel must exist in the same graph. Every declared Parallel
branch must have exactly one path to the paired Merge input of the same ID; no
undeclared input may be connected, no path may cross another structured
boundary, and a Parallel may pair with only one Merge in V1. The Merge executor
receives the settled complete keyed ledger and returns it unchanged with the
canonical selected branch IDs.

The coordinator initializes one join state keyed by the Merge node ID and
declares the complete ledger from the immutable Parallel config. It records
`arrived`, `skipped`, `missing`, `failed`, or `canceled` explicitly from durable
facts. It never infers a disposition from an absent row. `all`, `any`, and
bounded `count(n)` settle exactly as ADR 008 specifies; `count(n)` must be
positive and no greater than the declared branch count. Every policy waits for
all declared branches to become terminal. Selection uses canonical branch-ID
order, an unsatisfied policy fails terminally, and duplicate facts cannot revise
the persisted selected set.

The Merge invocation becomes ready only after the complete join result is
persisted. Its scope removes the paired Parallel branch component, so one Merge
invocation represents the structured fan-in rather than one invocation per
incoming branch. Downstream input mappings address ledger entries by stable
branch ID and explicit source output reference.

### Durability and rollout

Checkpoint V2 persists the complete bounded join state, selected branch IDs,
Parallel limit, and branch-scoped invocations. PostgreSQL and the checkpoint CAS
are authoritative; BullMQ contains only reconstructable delivery hints. A fresh
coordinator reconstructs the same ready branches and Merge result after a crash
or Redis loss. Malformed pairing, scope, ledger, limit, output, or conflicting
duplicate state fails closed.

Parallel is implemented and released before Merge, but remains outside serving
cohorts until the paired end-to-end Parallel/Merge recovery fixture passes.
Parallel and Merge each use additive staged and active compatibility releases;
older releases remain immutable and executable from retained history.

## Consequences

V1 fan-out is bounded and deterministic, with explicit structured convergence
instead of arbitrary DAG joins. Waiting for a complete ledger makes `any` and
`count(n)` reproducible but intentionally slower than race-based joins. The
fixed sixteen-port cap simplifies immutable manifests and validation while
leaving larger fan-out to For Each.

## Rejected alternatives

- Treat ordinary multi-predecessor DAG nodes as implicit joins.
- Select `any` or `count(n)` winners by arrival or completion order.
- Infer skipped or missing branches from absent node-run rows.
- Let Parallel bypass run/workspace admission limits.
- Key branches by labels, array indexes, edge order, or generated UUIDs.
- Admit a serving Parallel release before the paired Merge recovery proof.
