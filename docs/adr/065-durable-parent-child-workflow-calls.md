# ADR065 — Durable same-workspace workflow calls

Status: **ACCEPTED — 2026-10-02.**
Primary accepted the complete decision at commit
`b6c2998d29408b086c289e87058f9c67d2008ff2`, tree
`777b902351dd2a0fee2b067993ede3bc4ab1364c`, after full source review and independent
Standards/Spec closure. Both reviews closed ancestor cancellation fencing;
Spec also closed definitive pre-reservation refusal classification. No actionable
delta findings remain. This is design acceptance, not executable proof.
Release owner globally reserved ADR065 exclusively for this F08 draft on
2026-10-02; allocation is not decision acceptance. Parent
[F08](../feature-plans/08-subworkflows.md); binding details and current-source
reconciliation in [the contract proposal](../feature-plans/08-subworkflow-contract-proposal.md).
Primary authorized implementation after accepting the release-qualified integrated
F07 base `0b4e0810d405ecb0b222a2e000d363ef4fbd2380`, tree
`27c2362ba58c9eb161335d89a6665200403d8052`, and exclusive migration0136 allocation.
Required real-service, compatibility and rollout evidence remains open.

## Context and selected direction

F08 needs reusable typed calls without copying graphs or occupying a parent
worker while a child executes. ADR012 and ADR058 count running and waiting runs,
plus committed reservations, against ordinary workspace/workflow capacity.
An unreserved queued child can therefore deadlock behind its waiting parent at
cap one. Primary selected strict independent occupancy and fail-fast admission
for the V1 proposal on 2026-10-02; this is not acceptance of every choice below.
Primary subsequently selected same-workspace callable pins, the bounded type and
expansion directions, configuration-only preview, membership-revision authority
and immutable family-deadline policy. Complete transaction/privilege design was
accepted with the independently reviewed revision above; implementation proof
remains open.

## Decision

Use same-workspace exact immutable callable-version pins and bounded typed
input/result contracts. A logical scoped call owns one durable admitted child or
definite refusal. Extend the existing pure engine, coordinator checkpoint CAS,
canonical run acceptance/reservation, event/outbox and retention owners. Never
introduce a recursive executor, public-HTTP workaround, graph copy, family
scheduler or another history authority.

A waiting parent retains ordinary active occupancy but releases its worker.
Child acceptance obtains an independent ordinary reservation atomically with
acceptance and the parent's call-control CAS, preserving queue bounds, child
workflow FIFO and workspace fairness. Otherwise commit a definite refusal with
no child accepted. Capacity refusal is ordinary required-node failure, not a
provider error or promise of deferred execution. Cap one cannot run a nested
call; any fully occupied workspace can refuse one. No automatic call retry or
new child after refusal/unknown; explicit parent replay remains a new execution.

Pin the whole acyclic dependency closure, including schema/result selector and
execution policies. Proposed bounds are depth four, 64 children/root and 1,000
expanded family node invocations, including loop products. Keep old formats and
pins immutable; stage explicit new format/policy versions rather than reinterpret
retained V1/V2 graphs or checkpoints. Use the existing Manual entry contract for
the initial callable child and do not fake child execution in node preview.

Root initiation authority is durable and explicit: human-origin calls recheck
the initiating actor and the root's pinned membership role revision for fresh
child admission. Any revision change, even promotion, refuses a future child;
already accepted children are not retroactively canceled. Implemented membership
remove/rejoin/suspend/reactivate transitions advance that revision; user-global
and workspace status checks do not imply a new suspension generation.
Automated roots use admitted workspace-trigger authority, never a publisher's
session. Current child
lifecycle/compatibility, region, entitlement, capacity, FIFO and connection
policies remain enforced. Already accepted children settle after actor departure,
archive or rollback according to existing accepted-run truth.

Child deadlines never exceed their parent's absolute deadline; pin the bounded
one-hour default in the new executable family policy and accepted root, never
an ambient fallback for recovered/retained runs. Cancellation stops fresh spawn
and durably propagates to admitted children. Unknown effects outrank cancellation,
timeout and failure; final parent cancellation waits for truthful reconciliation.
Child terminal state plus a parent wakeup commits atomically, without holding
both child and parent locks. Duplicate/lost wakeups reconstruct from PostgreSQL
and resume the parent once through its own CAS.
Spawn holds a verified bounded root-to-parent lineage fence: ancestor SHARE rows
before the immediate parent's direct NO KEY UPDATE/CAS, no lock upgrade when the
root is that parent. Selected-run cancellation UPDATE serializes with this fence;
if cancel wins, no child is admitted; if spawn wins, that child is accepted work
requiring reconciliation. Terminal producers never lock ancestors while holding
their own run. Final PostgreSQL-clock checks enforce immutable ancestor deadlines.

All definite authoritative policy rejections, including those before reservation,
converge on one immutable refusal after candidate savepoint rollback. Infrastructure,
unsupported protocol/artifact and corruption failures roll back the whole outer
transaction for existing transport/CAS recovery; uncertain commit is resolved by
durable identity, never fabricated as definite refusal. Reuse the concrete
transaction-local WorkspaceTransaction adapter and canonical acceptance; a narrow
tenant-bound worker proof binds child insertion/reservation, not general dispatcher
privileges or a second admission owner.

Keep dependency versions, lineage, terminal/results and artifact references
while needed by nonterminal parents, replay-eligible history or legal hold;
extend bounded existing purge/retirement queries instead of adding a retention
owner. OFF denies new roots/publications, not compatible accepted continuation
or settlement. No production enablement or mixed-old-writer safety is claimed
without executable source-bound readiness/write-barrier and recovery proof.

The contract proposal specifies the private interface extension, transaction and
savepoint refusal behavior, proposed non-inverting lock/FIFO order, disclosure,
preview and exact verification obligations. Independent design review, primary
acceptance and release-owned integration/migration allocation are complete;
executable implementation and verification remain separate gates.

## Alternatives and consequences

- Ordinary queued child admission: rejected because it can wait behind its own
  parent and consume durable backlog without progress.
- Family exemptions or separate extra child quota: rejected for V1 because they
  change the hard meaning of active capacity and can amplify tenant work.
- Conserved-slot handoff after quiescing a parent: not selected for V1; requires
  explicit new suspended-parent accounting, parallel-branch quiescence, workflow
  slot reacquisition/FIFO and cancellation/retirement semantics.
- In-process child execution or embedding its graph: rejected because worker
  occupancy, restart identity, reusable version pins and inspection would diverge
  from existing execution ownership.

The selected direction conserves current admission guarantees and avoids a new
capacity framework, at the cost of product-visible call failures under capacity
pressure and inability to nest at workspace cap one. Durable callable pinning,
authority and retention still add necessary cross-package state and qualification;
bounded scopes and reuse do not remove those obligations.
