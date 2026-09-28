# F20 — Sandboxed custom code nodes

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: New isolated execution platform. Relative size: **XL**, not a calendar estimate.

## Outcome

Users perform bounded transforms that standard nodes cannot express without risking other tenants.

## Current implementation and evidence

Restricted JSONata exists. Arbitrary JavaScript/Python user execution is explicitly deferred and is not safe to add inside existing worker process.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [docs/workflow-platform-backend-plan.md](../../docs/workflow-platform-backend-plan.md)
- [docs/adr/009-restricted-jsonata.md](../../docs/adr/009-restricted-jsonata.md)
- [packages/node-sdk/src/server.ts](../../packages/node-sdk/src/server.ts)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

02, 12; dedicated threat model and approved infrastructure budget.

Isolation technology, allowed language/dependencies, runtime lifecycle, supply-chain patching and pricing/resource budgets. Node vm alone is not a hostile tenant sandbox.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

SDK execution seam plus dedicated sandbox runtime adapter; worker capability broker; model/node contracts; web code editor. Never API-process eval.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Code editor with language/runtime version, input/output contract, safe test mode, bounded logs and resource errors.

## Backend work

Separate sandbox adapter/runtime, pinned runtime image, CPU/memory/time/output limits, filesystem/network denial defaults, teardown proof and tenant isolation. Capability broker only for explicitly approved effects; no worker secrets or host environment.

## Delivery slices

1. Threat model and ADR compare viable isolation options; choose one language and pure transforms first.
2. Prototype hostile code isolation and cancellation/resource enforcement before catalog publication.
3. Deliver versioned code node and test UX; later allowlisted capabilities require new review.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Escape attempts, infinite loop/memory/output flood, orphan process, cancellation, poisoned cache, cross-tenant files, restart and no outbound traffic by default.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

eval in API/worker, arbitrary packages/network, promising sandbox safety from normal tests alone.

## Rollout and rollback

Stop new code admissions while draining/killing owned isolated tasks safely; retain pinned executors for supported runs or document quarantine.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

n8n Code supports JavaScript/Python; comparable functionality requires isolation engineering, not just a text editor. Sources: [n8n Code node](https://docs.n8n.io/build/code-in-n8n/using-the-code-node).

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
