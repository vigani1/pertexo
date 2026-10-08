# F08 — Reusable subworkflows with durable parent/child runs

Status: proposed plan; not implementation-authorized by this document.
The first implementation (#149, #159, #162) was reverted on 2026-10-08; F08 will
be re-planned after the architecture reset.
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

- [ ] Baseline reconciled against current code and accepted decisions.
- [ ] Product choices resolved; necessary ADR accepted.
- [ ] Contracts and failure/security model reviewed.
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [ ] Real integrated acceptance evidence recorded.
- [ ] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

Evidence log: none for this new plan. Existing foundations above are not completion
of the proposed increment. Mark genuinely inapplicable rows with a reason rather
than fabricating work.
