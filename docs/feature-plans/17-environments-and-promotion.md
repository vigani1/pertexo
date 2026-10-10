# F17 — Development/production environments and safe promotion

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: New enterprise-oriented lifecycle. Relative size: **XL**, not a calendar estimate.

## Outcome

Teams validate changes away from production and promote an exact reviewed artifact with explicit connections and variables.

## Current implementation and evidence

Immutable versions and restore/diff exist. They are not separate environments, connection bindings or source-controlled promotion.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [apps/web/src/features/workflow-settings/pages/workflow-versions.tsx](../../apps/web/src/features/workflow-settings/pages/workflow-versions.tsx)
- [docs/adr/002-postgresql-jsonb-drafts-immutable-versions-checksum-identity.md](../../docs/adr/002-postgresql-jsonb-drafts-immutable-versions-checksum-identity.md)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

05, 13 and 16; 08 dependency graph when subworkflows included.

Tenancy/isolation, credentials, review policy, whether replay remains in source environment; never merely point dev at production secrets.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Authoring/promotion application; database environment/binding lifecycle; contract manifests; web versions/environments; deployment remains external.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Environment selector, dependency/configuration diff, binding checklist, promotion preview and audit trail. Git connection is later, not required for first controlled promotion.

## Backend work

ADR for isolation unit, environment binding/promotion identity, compatible dependency bundle and atomic activation/rollback. No copying secret bytes; each environment authorizes its bindings.

## Delivery slices

1. Choose separate workspaces versus environment entity using tenancy/security tradeoffs.
2. Implement exact-version promotion and dry-run dependency/binding validation.
3. Deliver UI and rollback; optionally Git-backed manifests after portable representation stabilizes.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Promoting a child dependency, missing binding, drift during approval, partial failure, concurrent promotion, rollback preserves historical pins, no secret export.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Git as live runtime authority, environment flags that bypass RLS, automatic production deployment.

## Rollout and rollback

Previous immutable activated version and binding set restore through audited command, not database reset.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

n8n documents Git-backed source control/environments, with plan-specific availability. This is later than basic authoring and reuse. Sources: [n8n source control and environments](https://docs.n8n.io/administer/use-source-control-and-environments); [Zapier drafts and versions](https://help.zapier.com/hc/en-us/articles/9693520498445-Create-Zap-drafts-and-versions).

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
