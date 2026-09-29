# F18 — Audit visibility, publishing approval and advanced access

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Existing tenancy foundation + new governance UX. Relative size: **XL**, not a calendar estimate.

## Outcome

Teams can answer who changed what and restrict consequential changes without duplicating authorization rules.

## Current implementation and evidence

Workspace membership/roles, auth and audit facts exist. Complete product audit browsing, publication review and enterprise identity provisioning are not established.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [apps/api/src/identity-workspace](../../apps/api/src/identity-workspace)
- [docs/adr/039-better-auth-and-session-authority.md](../../docs/adr/039-better-auth-and-session-authority.md)
- [docs/implementation-progress.md](../../docs/implementation-progress.md)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

00; 17 for promotion approval, 03 for review notices optional.

Which events may users read, separation of duties, owner emergency policy, retention/export constraints; do not infer organization roles from external email domain.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## User-configurable settings

Recommended values, confirmed in this feature's ADR. The server enforces every
range; the control states its consequence.

| Setting | Default | Range | Who changes it | Consequence shown |
| --- | --- | --- | --- | --- |
| Keep run data | Platform default | 1 day to the platform default | Workspace owners and admins; audited | “Run inputs and outputs older than this are deleted; legal holds still apply” |
| Require review before publishing | Off | Off or on | Workspace owners | “Publishing waits for an approving reviewer who is not the author” |

## Ownership and structure

Identity/workspace policy plus authoring review commands; database audit/read/review ownership; contracts; web audit/review.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Audit viewer with authorized filters, revision diff and publishing review status; later service-account/enterprise identity settings if demanded.

## Backend work

Safe audit read projection and bounded indexes/retention; review record bound to immutable candidate hash; execution command rechecks permission and review freshness. Workspace-configurable retention of run data within ADR 013's bounds and legal holds. SSO/SCIM is planned in [F28](28-single-sign-on-and-provisioning.md); external secret stores require a separately approved security/provider slice.

## Delivery slices

1. Expose sanitized audit events with retention coverage and exact actor attribution.
2. Add publish-review policy with stale-review invalidation and reasoned decisions.
3. Add workspace run-data retention settings (shorter than the platform default, never beyond it or past a legal hold) with their audit trail.
4. Only then evaluate custom roles or credential-sharing granularity from concrete team requirements; SSO/SCIM is F28.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Reviewer loses role, draft changed after approval, self-approval restrictions, tenant isolation, sensitive fields absent, pagination/retention and denied publication.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

General ACL rewrite, unsupported compliance claims, merging audit logs with personal notifications.

## Rollout and rollback

Disable new policy creation; existing enforced review policies require explicit safe transition, not silent bypass.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

n8n documents workflow review and sharing; Zapier version docs describe publishing restrictions. Scope and entitlement details vary. Sources: [n8n current documentation index](https://docs.n8n.io/sitemap.md); [Zapier drafts and versions](https://help.zapier.com/hc/en-us/articles/9693520498445-Create-Zap-drafts-and-versions).

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
