# F15 — Bounded synchronous webhook responses

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: New opt-in trigger mode. Relative size: **XL**, not a calendar estimate.

## Outcome

A caller can opt into a short bounded request/reply workflow where a result is genuinely required.

## Current implementation and evidence

Current webhook durably accepts and returns 202. A synchronous result response is explicitly deferred.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [docs/workflow-platform-backend-plan.md](../../docs/workflow-platform-backend-plan.md)
- [apps/api/src/webhooks/ingress.ts](../../apps/api/src/webhooks/ingress.ts)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

01; response/output contract; keep current asynchronous ingress intact.

Recommend timeout returns accepted run reference rather than pretending run canceled; exact status contract must be approved. Child waits/human approvals cannot keep an HTTP request open indefinitely.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Application webhooks/response reads; database response correlation; engine/worker response decision; contracts; web trigger settings.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Trigger mode, response status/header/body mapping, timeout/fallback explanation and examples; distinguish server receipt from completed result.

## Backend work

ADR for durable response record/correlation, bounded waiting on a committed result, replica-safe wakeups, one response winner, disconnect/timeout semantics and run continuation. Queues stay execution transport, not an in-memory promise dependency.

## Delivery slices

1. Approve hard wait/body/header limits and allowlisted eligible workflow behavior.
2. Implement response persistence, correlation and wait cleanup while preserving 202 default.
3. Add authoring/docs and real multi-instance timeout/disconnect tests.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Completion/timeout race, duplicate ingress, client disconnect, server restart, two response nodes, unsafe header injection and bounded concurrent waits.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Indefinite sockets, bypassing durable run acceptance or using API process for actual node execution.

## Rollout and rollback

Disable new synchronous endpoints; existing asynchronous webhooks unchanged, accepted runs continue.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

n8n has Respond to Webhook; replicate the use case only with explicit Pertexo timeout/durability semantics. Sources: [n8n Respond to Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.respondtowebhook).

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
