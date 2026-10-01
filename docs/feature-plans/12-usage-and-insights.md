# F12 — Usage, limits and workflow insights without billing

Status: first read-only capacity/activity slice complete, merged in PR137 with
required checks and release-owner natural main qualification passed;
warnings and trends remain deferred. This document does not authorize production rollout.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Backend projection + frontend reporting. Relative size: **L**, not a calendar estimate.

## Outcome

Users understand retained execution activity, resource limits and consumption with truthful coverage/freshness.

## Current implementation and evidence

The ADR057 first slice adds current execution/artifact capacity and separately
labelled retained activity to the Usage page. Bounded workspace run statistics
remain owned by ADR044. This is not the complete F12 product and does not rename
run counts to billable usage.

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

Deferred proposals, not accepted settings in ADR057 or enabled controls. The
first slice uses fixed durations and existing configured entitlements; it has no
warning, timezone/reset or quota-editing settings.

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

The first slice shows separate snapshot timestamps, current capacity versus
configured limits, unavailable versus zero, and exact-bound retained-activity
drill-downs. Period/zone settings and workflow trends/duration distributions
remain deferred.

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

- [x] Baseline reconciled against current code and accepted decisions.
- [x] First-slice product choices resolved; ADR057 accepted. Later warnings,
  trends and calendar/timezone decisions are not part of this slice.
- [x] First-slice contracts and failure/security model reviewed locally.
- [x] First-slice backend behavior implemented and independently verified.
- [x] First-slice frontend behavior implemented and independently verified.
- [x] First-slice real integrated acceptance evidence recorded.
- [x] First-slice rollout/rollback and limitations documented in ADR057.
- [x] First-slice scoped PR137 merged with required exact-head checks passed.
- [x] Natural postmerge main qualification inspected and passed by the release owner.

Evidence log:

- 2026-10-01: the release owner confirmed natural main
  [CI run 36806860550](https://github.com/vigani1/pertexo/actions/runs/36806860550)
  and [CodeQL run 36806860572](https://github.com/vigani1/pertexo/actions/runs/36806860572)
  both concluded `SUCCESS` on merged commit `23cc5b45`, and recorded the manager
  receipt. This closes the first read-only capacity/activity slice's postmerge
  qualification, not the deferred warnings/trends product or production rollout.
- 2026-10-01: the release owner reported all exact-head CI checks passed and
  [PR137](https://github.com/vigani1/pertexo/pull/137) merged at 02:39:28 UTC as
  `23cc5b452f647788dad704f5f0b3114330122712`; fetch confirmed that commit on
  `origin/main`. Natural main CI `36806860550` and CodeQL `36806860572` were
  queued at that point; the subsequent release-owner success receipt above
  supersedes that pending status. This merge receipt alone did not establish
  main qualification, production rollout, or the deferred warnings/trends product.
- 2026-10-01: [ADR057](../adr/057-workspace-usage-capacity-and-retained-activity.md)
  records the selected metric dictionary, conservative existing-capability
  intersection, fixed-window activity, exact byte representation and bounded
  read strategy. Source inspection confirmed dispatch reservations are excluded
  from admission counters and require their own scoped count; absent execution
  entitlement is unavailable, while absent artifact capacity in a new active
  workspace uses the existing writer's lazy defaults. These are implementation
  decisions and inspected source evidence, not a completed persistence/browser
  acceptance claim.
- Existing foundations above are not completion of this increment. Warnings,
  trends, operation/attempt meters, timezone/reset settings, entitlement editing
  and billing are explicitly deferred. At that inventory point the first slice
  remained unmerged; the later PR137 evidence above supersedes that status.
- 2026-10-01: local first-slice evidence: contracts 135 tests; API focused
  authorization/persistence tests 94; database unit suite 878 tests plus 64
  focused readiness/reader tests after the final body pin; isolated PostgreSQL
  integration 20 tests, including explicit 0125→0126 upgrade, context/role
  isolation, reader-body/index drift, indexed reservation counting and bounded
  statement timeout. The reader body fingerprint is pinned in startup readiness
  and the operations inventory. These are local results, not CI results.
- 2026-10-01: web unit suite 764 tests passed with two workers. The real
  BetterAuth/PostgreSQL/Redis/browser fixture passed against isolated owned
  services: one active run, one queued run, 11 charged bytes, distinct 1-hour
  (3 runs) and 6-hour (4 runs) activity, exact-bound status drill-down and a
  settled 390px keyboard-operated view. No production data or external billing
  calls were used. Full browser suite passed 86 tests (80 Chromium, 3 Firefox,
  3 WebKit) with two workers and unchanged budgets.
- 2026-10-01: all repository `pnpm check` gates passed locally, with the final
  duplication/contracts/typecheck/test sequence resumed after reviewing two
  stale identity-fixture clone fingerprints. Aggregate clone ceilings stayed
  unchanged and one per-clone ceiling decreased. The repository unit run passed,
  including API 1710, database 878 and web 764 tests with their normal commands.
  An earlier benchmark process-startup timeout passed both in isolation and in
  the subsequent serial gate run; no timeout budgets were changed. No push, PR,
  merge or postmerge CI is claimed.
- 2026-10-01: recorded implementation commits `3abde4ae` (backend/contract)
  and `6ce2637e` (page/integrated evidence), following ADR commit `5af88e02`.
  Normal merge `87ec4177` incorporates main cleanup fix `1af50311` without
  rewriting history. After that local merge, the API dependency build, 47
  focused cleanup/Usage tests and both real capacity/browser integration tests
  passed. The two owned temporary services were closed after confirming no
  fixture databases remained. This is local integration, not a feature PR merge
  or postmerge CI result; manager review still precedes any push/PR.
- 2026-10-01: manager review found that a transient failure after an access
  denial could reveal the pre-denial Query snapshot again. Usage reads now
  forget denied capacity and all scoped activity-window snapshots in Query;
  sibling window requests are canceled before clearing to prevent cancellation
  from restoring earlier data. Only fresh authorized success restores figures.
  Regression coverage exercises 401/403/404/409, subsequent transient failures,
  remounts/window changes and independent recovery, while preserving ordinary
  transient-error stale display. Verification: 22 focused Usage tests, all 771
  web unit tests, all 87 browser tests (81 Chromium, 3 Firefox, 3 WebKit), build,
  typecheck, scoped lint, architecture, complexity, duplication and formatting
  checks pass. Browser regressions include both 503 and network failures after
  denial. This repair has not been pushed and does not claim new live-backend
  or CI evidence.
