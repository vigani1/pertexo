# ADR 018: Switch ordered case selection and stable branch ports

- **Status:** accepted
- **Date:** 2026-08-24

## Context

ADR 017 establishes authoritative persisted output, checkpoint V2 branch
selection, explicit skips, and scoped invocation identity for Condition. Switch
must reuse that scheduler authority while supporting more than two branches.
Without a narrower contract, case evaluation could depend on object-key order,
canvas order, an unpinned expression evaluator, or dynamically generated ports
that the immutable node manifest cannot validate.

## Decision

### Versioned node contract

The first Switch definition and executor are `core.switch@1` under executor ABI
1. It belongs to the `logic` family and uses the `cpu` resource class and `safe`
retry class. It has one `in` input port, sixteen fixed case output ports named
`case-01` through `case-16`, and one `default` output port.

The input is `{ value: JsonScalar }`, where `JsonScalar` is `null`, boolean, a
finite JSON number, or a string of at most 1,024 Unicode code points. Config is
`{ cases: Case[] }`, with one through sixteen ordered cases. Each case is
`{ id: CasePort, equals: JsonScalar }`; case IDs must be unique. Duplicate match
values are allowed because ordered first-match behavior is part of the contract.
Output is `{ selectedPort: CasePort | "default" }`. Every schema is strict and
bounded.

The executor compares the validated input scalar to cases in stored array order
using JSON scalar equality. Numbers compare by numeric value, strings by exact
code-point sequence, booleans by value, and null only to null. The first match
wins; no match selects `default`. The executor performs no JSONata evaluation,
coercion, locale comparison, regular expression matching, or graph traversal.
Input mappings remain the only expression boundary.

### Stable topology and branch identity

Case order controls precedence, but branch identity is the explicit case ID,
not its array index. Reordering cases without changing IDs therefore changes
precedence but does not rename persisted branch scope. Object-key order, node
array order, edge order, canvas position, and completion order have no effect.

Publication rejects duplicate case IDs, edges leaving through an unconfigured
case port, and source ports outside the fixed manifest. The `default` port is
always configured. A configured branch may have zero or more outgoing edges.
Until Merge is released, descendants reached from distinct Switch ports may not
reconverge.

### Durable authoritative selection

Switch uses the ADR 017 path unchanged: an ordinary succeeded attempt stores
the bounded `{ selectedPort }` output; the coordinator correlates that output
with the exact durable succeeded fact and immutable executable; checkpoint V2
records one immutable selection; and the CAS transaction persists selected
readiness plus explicit non-selected skips. Queue payloads and worker memory are
never selection authority.

The scheduler derives declared Switch ports from the pinned node config and
manifest. Duplicate observation of the same selection is inert. A conflicting
selection, an unconfigured selected port, malformed output, or selection for a
non-succeeded invocation fails closed. Scope appends the Switch node ID and
selected output port exactly as for Condition. Skipped branches create no
attempt or attempt outbox row.

### Compatibility and rollout

Switch is introduced through additive staged and active releases after its full
vertical recovery matrix passes. Existing Condition and older releases remain
immutable and executable through retained history. New Switch-containing runs
initialize checkpoint V2; root-only V1 runs retain checkpoint V1 semantics.

## Consequences

Switch shares one branch-selection subsystem with Condition and remains
deterministic across duplicate delivery, crashes, Redis loss, and fresh-worker
recovery. Fixed bounded ports make manifests and publication validation simple,
at the cost of a V1 maximum of sixteen cases and scalar-only matching.

## Rejected alternatives

- Evaluate unrestricted expressions or JSONata inside Switch.
- Derive case IDs from array indexes or labels.
- Generate arbitrary output ports outside the immutable manifest.
- Compare objects or arrays with unspecified equality semantics in V1.
- Infer selection from the only branch that happened to execute.
- Store selected cases only in BullMQ payloads or worker memory.
