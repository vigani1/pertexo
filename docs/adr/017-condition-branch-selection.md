# ADR 017: Condition branch selection and durable reachability

- **Status:** accepted
- **Date:** 2026-08-23

## Context

ADR 008 requires stable branch identifiers, explicit skipped dispositions, and
checkpointed scheduler facts, but it does not define how a Condition result
selects an output port or how that selection changes graph reachability. The
current scheduler also drops edge ports and treats every predecessor as
mandatory. Adding Condition without a narrower decision would let recovery
infer a branch from missing rows, completion order, or worker memory.

Condition is the first orchestration node. Its representation must establish a
compatible branch-selection seam for Switch while not implementing Merge,
Parallel, or general structured bodies prematurely.

## Decision

### Versioned node contract

The first Condition definition and executor are both `core.condition@1` under
executor ABI 1. The definition belongs to the `logic` family, uses the `cpu`
resource class and `safe` retry class, and has one `in` input port plus `true`
and `false` output ports.

Its strict schemas are:

```txt
config: {}
input:  { condition: boolean }
output: { selectedPort: "true" | "false" }
```

The executor performs no expression evaluation. The existing pinned restricted
JSONata input-mapping policy resolves the boolean before invocation. The
executor returns `true` only for `condition === true` and `false` only for
`condition === false`; coercion is rejected by schema validation.

Condition is introduced through a new additive compatibility release. Older
release fingerprints, manifests, executors, and retained executable fixtures
remain immutable. A release that does not contain Condition cannot publish or
execute it, and execution never falls forward to a newer executor.

### Authoritative selection

A succeeded Condition attempt stores its bounded output through the ordinary
attempt-output path. The coordinator loads that persisted output, validates it
against the exact pinned `core.condition@1` output schema, and converts it into
one typed branch-selection observation. Queue or event payloads do not carry an
authoritative selected port.

The scheduler records exactly one immutable selection for each succeeded
Condition invocation:

```txt
invocationKey, nodeId, selectedOutputPort
```

`selectedOutputPort` must be one of the immutable definition's declared branch
ports. Duplicate observation of the same selection is inert. A conflicting
selection or a selection for a non-succeeded Condition fails closed.

### Reachability and scope

Published Condition edges must leave through `true` or `false`. The stable
branch identifier is the pair of Condition node ID and source output port. All
nodes reached through the selected port become eligible under that branch
scope; nodes reached only through the other port are explicitly skipped. A
skipped invocation is persisted terminally with no attempt row and no node
attempt outbox event. Absence never means skipped.

The canonical invocation scope appends the Condition node ID and selected port
to the ordered outer scope defined by ADR 008. Fan-out from one selected port
shares that branch scope; ordinary node IDs continue to distinguish logical
invocations. Node and edge array order, canvas position, and completion order do
not affect selection, scope, skips, or readiness.

Merge is not available in the Condition slice. Until an explicit Merge
definition and join policy are released, publish validation rejects a topology
where descendants of the `true` and `false` branches reconverge. This prevents a
node from being admitted merely because one predecessor was marked skipped.
Direct fan-out within either individual branch remains allowed.

### Checkpoint and transaction boundary

Branch selections and branch-scoped invocation facts use checkpoint schema
version 2. Version 1 remains readable with its original root-only semantics and
is never reinterpreted as version 2. New Condition runs pin version 2; malformed,
oversized, unsupported, duplicate-conflicting, or internally inconsistent
selection state fails closed.

Version 2 stores selections in canonical `(invocationKey, nodeId)` order and
retains edge source ports in the scheduler projection. The coordinator computes
selected readiness and non-selected skips from the immutable executable,
persisted attempt output, and current checkpoint only. It atomically commits the
selection, checkpoint revision, skipped invocations, and newly admitted
attempts through the existing compare-and-swap transaction. A stale or duplicate
coordinator reloads and computes the same plan.

Cancellation before selection records no selection and admits no branch work.
Cancellation after selection preserves the durable selection and existing
dispositions but admits no additional work, as required by ADR 008.

## Consequences

Condition recovery is deterministic across duplicate delivery, coordinator
crashes, Redis loss, and fresh workers. The selected branch can fan out, while
the unselected branch has explicit terminal evidence and cannot accidentally
execute. The cost is a new checkpoint version and branch-aware invocation scope
before later orchestration nodes are introduced.

Switch can reuse the selection observation and checkpoint representation with a
different bounded set of declared ports. Merge must later define the boundary
that permits branch reconvergence; this ADR deliberately rejects reconvergence
rather than guessing those semantics early.

## Rejected alternatives

- Evaluate a Condition expression inside the node in addition to input mapping.
- Infer the selected branch from absent node rows or outputs.
- Put the selected port only in a queue or event payload.
- Mutate checkpoint version 1 while retaining the same version number.
- Allow pre-Merge reconvergence and treat skipped predecessors as satisfied.
- Add a latest-executor fallback for retained workflows.
