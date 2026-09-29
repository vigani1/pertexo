# F12 — Usage, limits and workflow insights without billing

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Backend projection + frontend reporting. Relative size: **L**, not a calendar estimate.

## Outcome

Users understand retained execution activity, resource limits and consumption with truthful coverage/freshness.

## Current implementation and evidence

Bounded workspace run statistics exist (ADR044), as do operational/admission limits. No complete user-facing usage product is proven; do not rename run counts to billable usage.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [docs/adr/044-bounded-workspace-run-statistics.md](../../docs/adr/044-bounded-workspace-run-statistics.md)
- [apps/web/src/features/overview](../../apps/web/src/features/overview)
- [apps/web/ARCHITECTURE.md](../../apps/web/ARCHITECTURE.md)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

00; agree units/period before implementation; can ship before 08 if demand warrants.

Period zone/reset, inclusion/exclusion, read capability, freshness, retention coverage, who sets entitlements.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## User-configurable settings

Recommended values, confirmed in this feature's ADR. The server enforces every
range; the control states its consequence.

| Setting | Default | Range | Who changes it | Consequence shown |
| --- | --- | --- | --- | --- |
| Usage warning | At 80% of a limit | 50–95% | Workspace admins | “Admins get a notice when usage reaches this share of a limit” |
| Reporting time zone | Workspace time zone | Any IANA zone | Workspace admins | “Periods start at midnight in this zone” |

## Ownership and structure

Application usage/insights reads; database bounded aggregate owner; contracts; web usage. Existing limits/accounting owners remain authoritative.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Usage page with measured-through timestamp, period/zone, limits versus actual usage, unavailable versus zero and drill-downs. Later workflow trends/duration distributions only from bounded authoritative projections.

## Backend work

Define durable measurement units and authoritative sources; scoped aggregates and indexes, late data/retention semantics, exact retry/cancel/subworkflow treatment. Rollups only when justified, reconcilable from durable facts.

## Delivery slices

1. Approve metric dictionary: runs, attempts or consumed operations are different; storage is separate.
2. Deliver minimal bounded read contract and UI for selected units.
3. Add quota warnings and trends with proven query plans; reserve billing ledger changes for 23.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Period/DST edges, retries/canceled runs, duplicate accounting, late events, partial retention, permissions, bounded SQL and no browser-side full-history aggregation.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Prices, checkout, invoices, treating infrastructure metrics as customer billing, unsupported lifetime totals.

## Rollout and rollback

Hide new reporting reads without changing enforced entitlements or execution acceptance.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

Operational visibility is useful before paid plans; compare conceptual reporting, not competitor billing units. Sources: [n8n current documentation index](https://docs.n8n.io/sitemap.md).

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
