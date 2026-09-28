# F10 — Durable human approvals and resume decisions

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: New cross-stack durable interaction. Relative size: **XL**, not a calendar estimate.

## Outcome

A workflow waits durably for an authorized human decision and resumes exactly once without holding a worker.

## Current implementation and evidence

Timed waits exist. Human approvals/external resume forms remain deferred; inbox read state is not an approval.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [docs/workflow-platform-backend-plan.md](../../docs/workflow-platform-backend-plan.md)
- [docs/adr/021-durable-wait.md](../../docs/adr/021-durable-wait.md)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

03 for in-app discovery; 01; durable wait patterns reused, not notification read state.

Approve-any versus all, escalation/reassignment, decision visibility and retention. Recommend single authorized decision first; freeze scope before schema.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Application approvals; database decisions; engine durable wait/resume; worker outbox; contracts; web approvals/editor; notifications only as projection.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Approval node settings, assignee policy, review detail with safe context, approve/reject/comment and expired/reassigned/canceled states; inbox links to canonical task.

## Backend work

ADR: pending decision record, eligible audience, revision/expiry, one atomic decision winner, audit and outbox wakeup. Recheck authorization at decision, bind to exact run/invocation/version.

## Delivery slices

1. Specify authenticated workspace approvals first, rejection/expiry and self-approval policy.
2. Implement persistence and worker resume under concurrent decisions/cancel/expiry.
3. Deliver approval queue/detail and inbox event; add external one-time links only in a separate security-reviewed slice.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Approve/reject race, replayed link/command, revoked member, expiry versus approval, run canceled/deleted, restart while waiting, only one resume.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Treating mail delivery or notification mark-read as approval; anonymous approval by guessable ID.

## Rollout and rollback

Disable new approval publication; existing pending tasks remain decidable or explicitly canceled through supported operations.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

Zapier Human in the Loop explicitly pauses workflows for review/intervention; match durable decision semantics, not just the dialog. Sources: [Zapier Human in the Loop](https://help.zapier.com/hc/en-us/sections/38731226552845-Human-in-the-Loop).

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
