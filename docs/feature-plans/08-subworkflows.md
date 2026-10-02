# F08 — Reusable subworkflows with durable parent/child runs

Status: accepted ADR065; implementation in progress, callable type foundation verified.
Decision preparation is authorized; primary selected strict independent occupancy
and fail-fast child admission for the V1 proposal on 2026-10-02. The complete
contract/ADR was accepted at `b6c2998d29408b086c289e87058f9c67d2008ff2` after
primary source review and independent Standards/Spec closure.
Primary additionally selected bounded portable closed-object contracts, exact
same-workspace pins, depth-four/64-child/1,000-expanded-work bounds,
configuration-only preview, conservative membership-revision authority and
immutable publication/root family-deadline policy. Transaction/privilege and
independent design review closure are complete; executable proof remains pending.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: New execution capability across both stacks. Relative size: **XL**, not a calendar estimate.

## Outcome

One published workflow calls a reusable published child with typed inputs/results and inspectable parent-child history.

## Current implementation and evidence

Nested For Each bodies exist inside one run; they are not reusable child workflows. Subworkflows remain explicitly deferred in the backend plan.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [docs/workflow-platform-backend-plan.md](../../docs/workflow-platform-backend-plan.md)
- [docs/adr/020-bounded-for-each.md](../../docs/adr/020-bounded-for-each.md)
- [packages/workflow-engine/src/index.ts](../../packages/workflow-engine/src/index.ts)
- [apps/api/src/workflow-runs](../../apps/api/src/workflow-runs)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

01 and 02 recommended; 05 for later portable dependency bundles. Design early; implement after current engine cleanup.

Recommend wait-for-result only first, no recursion/cross-workspace calls. Define who authorizes child use, parent deadline propagation, accounting, deletion/pinning and outcome_unknown propagation.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

Current bounded decision evidence is in the
[contract proposal](08-subworkflow-contract-proposal.md) and
[ADR065](../adr/065-durable-parent-child-workflow-calls.md), accepted on 2026-10-02.
A waiting parent retains its
ordinary active slot. Fresh child acceptance must reserve an independent ordinary
slot with existing FIFO/entitlement checks or fail definitely with no child;
cap one cannot execute nested calls, and any full workspace can refuse a call.
Do not silently implement an extra child pool or conserved-token redesign.

## Ownership and structure

Model/SDK callable contract; engine call decisions; database parent-child admission/settlement; worker dispatch; contracts; web editor and run history.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Callable workflow input/output editor, Call Workflow node, exact-version picker/upgrade notice, parent/child run links and waiting/failure/cancel presentation.

## Backend work

ADR before schema: pin child immutable versions, durable invocation→child-run identity and idempotent spawn, authorization and entitlements, terminal completion wakeup/outbox, parent result projection. Parent waiting must release worker slots; no in-process recursive executor.

## Delivery slices

1. Define same-workspace typed call contract, pinning and acyclic dependency limits; reject recursion initially.
2. Implement idempotent child acceptance/completion and cancellation/deadline/failure behavior through engine/database/worker owners.
3. Deliver configuration and run lineage; later explicit extract-selection and asynchronous fire-and-forget modes.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Crash before/after spawn, duplicate wakeup creates one child, child wait/restart, two callers, changed publication cannot mutate in-flight pins, revoked access, cancellation race, parent resumes once.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

HTTP workaround calling our own public endpoint, child work within occupied parent slot, copying subgraph code as runtime invocation.

## Rollout and rollback

Disable new call-node publication; preserve readers/executors and child settlement for accepted runs.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

Zapier Sub-Zaps, n8n subworkflows and Make subscenarios all expose reusable calls. Their semantics are references, not permission to weaken Pertexo pinning. Sources: [Zapier Sub-Zaps](https://help.zapier.com/hc/en-us/articles/8496308527629-Create-reusable-Zap-steps-with-the-Sub-Zap-app); [n8n subworkflows](https://docs.n8n.io/build/flow-logic/break-workflows-into-smaller-parts); [Make subscenarios](https://help.make.com/subscenarios).

Research checked 2026-09-28; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation or billing policy.

## Delivery tracker

- [x] Baseline reconciled against current code and accepted decisions.
- [x] Product choices resolved; necessary ADR accepted.
- [x] Contracts and failure/security design reviewed (implementation proof pending).
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [ ] Real integrated acceptance evidence recorded.
- [ ] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

Evidence log: complete plan and relevant current ADRs/contracts inspected against
accepted F07 `e7d25e1f85342f10ae0044aadd408d88c49ea993`; exact anchors, proposal
interfaces, capacity/authority/deadline/retention decisions and verification seams
are recorded in the contract. Primary accepted ADR065 at exact `b6c2998d`, tree
`777b902351dd2a0fee2b067993ede3bc4ab1364c`, after both original independent
reviewers closed their design P1s with zero remaining actionable delta findings.
Primary subsequently accepted release-qualified integrated F07 base `0b4e0810`,
tree `27c2362ba58c9eb161335d89a6665200403d8052`, and exclusive migration0136
allocation, authorizing full implementation. The browser-safe portable type
descriptor, bounded runtime value validator and reusable inspector type field
are implemented. On Node24.15.0/pnpm11.22.0, the model suite passes 1,433 tests
across 19 files and the focused editor suite passes 16 tests with no skips.
Model build, web typecheck (after building engine/catalog prerequisites), narrow
lint/format checks, browser-condition built import and browser dependency
traversal pass. The exact browser allowlist exposes only the descriptor contract;
runtime validation remains behind the server model facade. Post-staging React
Doctor is unchanged at 89/100 with 12 existing F07 advisories and no new callable
diagnostics. This field is not yet wired into a callable workflow graph and does
not expose a runnable placeholder. The internal same-client transaction adapter
now supplies both existing workspace transaction wrappers without owning scope
or connection lifecycle. Its focused regression and transaction engine tests
pass (35 tests), as do all 1,032 database unit tests across 135 files, database
build/typecheck and narrow lint/format checks. It is not yet connected to child
acceptance and grants no public client-adaptation API. No persistent F08 schema,
child execution, restart proof or live UI evidence exists at this checkpoint.
Existing foundations are not completion of F08. Mark genuinely inapplicable rows
with a reason rather than fabricating work.
