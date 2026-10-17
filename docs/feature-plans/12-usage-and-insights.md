# F12 — Capacity warnings and run trends

Status: implemented and qualified locally; CI and merge tracked in the implementation PR.
Updated: 2026-10-17, against main after F29 (PR #331).
Decision: [ADR 057](../adr/057-workspace-usage-capacity-and-retained-activity.md).

## Outcome

Warn about approaching workspace capacity, and show how actual runs have behaved
across 30 or 90 days. Preserve the existing Usage page's exact current capacity
and separate retained activity. This is operational reporting, without billing.

## Decisions — 2026-10-17

### Capacity warnings

- Fixed threshold: 80% of each positive capacity limit. Four independent limits:
  active slots (including dispatcher reservations), queued runs, charged file
  bytes and charged file count. Waiting/Call slot handoff follows the existing
  admission owner. Tests consume real capacity and therefore participate here.
- Reuse F27's current-attention observer, Inbox audience and personal email
  preferences/digests. Operational readers see the warnings. No new recipient
  rule, worker service, transport, threshold setting or quota editor.
- One warning episode per limit per upward crossing: observing usage still above
  the threshold does not change its revision or send another notice. An observed
  drop below it resolves/rearms that limit; a later crossing opens a new episode.
  Separate limits resolve independently. Existing limit-reached notices remain.
- Observation and mail are best effort, like existing current-capacity notices:
  a brief crossing wholly between scans can be missed. A resolved warning is not
  mailed after capacity is rechecked. Do not add a per-mutation event subsystem.
- Keep warning state in existing Inbox threads: one stable subject/thread per
  workspace and capacity key, with a partial uniqueness constraint. An additive
  nullable `capacity_limit` distinguishes warning subjects; other kinds stay null.
  Preserve the existing subject key and failure-fold function. Active operational
  threads already survive retention; resolved threads expire normally. Existing
  workspace purge, private reads, preferences and mail cleanup still apply.
- One TypeScript capacity-rule owner supplies discovery and current-fact tests.
  Compare exact integer ratios, including bigint bytes, without floating-point
  rounding or bigint multiplication overflow. Missing/suspended/expired execution
  policy supplies no guessed warning limit; a zero limit uses existing reached
  feedback rather than an approaching-zero warning.

### Trends

- New read-only Trends page linked from Usage, with 30 or 90 **UTC calendar days,
  including today**. Today's bin is partial. Return fixed server `from`, `before`
  and `asOf`; do not infer browser-local day boundaries or add timezone settings.
- Use retained run summaries, never execution values or browser history paging.
  Exclude tests through the shared runs data-policy owner. Include actual child,
  replay and error-workflow runs; retries within a run do not add run counts.
  F29 skipped events remain separate from runs.
- Show runs per day by current outcome, average and slowest elapsed duration,
  and the top ten workflows by runs and by failures. Failures include failed,
  timed-out and unknown-outcome runs; canceled runs remain their own outcome.
- Elapsed duration is completion minus start, for terminal runs with a start.
  It includes waits and excludes time queued before starting. Missing durations
  stay unavailable, not zero. Retained summaries still work after details expire.
- Explain retained coverage: no lifetime claim or reconstructed deleted history.
  A late completion appears in the next snapshot. The selected interval is inside
  ordinary 90-day summary retention; workspace creation can shorten coverage.
- Preserve run-read authorization, workflow-name disclosure, workspace RLS,
  cancellation and the existing two-second statement budget. Bound response rows
  to 90 days and two top-ten lists. Measure indexed workspace/date-range reads;
  return an honest unavailable state on failure, without an unbounded fallback.
  No rollup table or reporting service.

## Structure

| Owner | Change |
| --- | --- |
| database/inbox/observations | Capacity predicate, discovery and per-limit episodes |
| database/schema/inbox; migrations | Nullable capacity key, warning constraints/index; existing RLS/grants |
| database/inbox/eligibility, projection, mail | Existing audience, safe metric labels, current-fact recheck |
| database/runs/queries; runs repository | Bounded trends snapshot with shared test exclusion |
| contracts; API workflow-runs/usage | Trends read and warning kind on current feature boundaries |
| web/features/usage; routes/workspace | Scoped Query reads, URL period and Trends page |
| web/features/inbox; worker/mail | Existing notice row, filter, safe email content |

No file moves are planned. Keep any necessary later moves in separate commits.

## Web direction and self-check

Keep Weft's existing semantic palette, local fonts, Status glyphs and plain forms.
The signature moment is a daily woven outcome chart; the duration summary and
rankings stay quiet. Supply equivalent readable daily data, keyboard-accessible
controls and exact labels. Fit 375px with reduced motion and no document overflow.
Reuse existing primitives and formatting; no chart dependency or new design system.
Query owns snapshots. Clear denied cached trends across periods, while preserving
ordinary transient-error stale feedback. Do not mirror results into component state.

Review: the reporting period, duration denominator, test inclusion, reservation
count and warning rearm are explicit. Existing Inbox state is sufficient; no new
subsystem is needed. Capacity warnings do not promise every transient spike or
successful email delivery. Publishing/execution behavior and capacity stay unchanged.

## Slices and verification

1. Extend warning persistence/rules and existing F27 delivery. Prove independent
   crossings, no repeated poll/run notices, restart/races, exact 80% boundaries,
   reservations, bigint bytes, zero/missing/suspended policy, permissions, mail
   reauthorization, long-active retention and workspace purge.
2. Add the trends contract, bounded database/API read and Weft page. Prove UTC
   edges, partial days, 30/90 selection, retained summaries, test exclusion, outcome
   and duration math, rankings/ties, tenant/name fences and measured query plans.
3. Qualify real API/browser behavior at desktop and phone widths; unit, mocked
   journeys, build, lint, types, contracts/schema/architecture and React Doctor.
   One PR, green CI, rebase merge before F02 suites.

## Tracker

- [x] Existing capacity/activity slice delivered (PR #137; history in Git).
- [x] Reconcile current code and record this increment's decisions.
- [x] Implement and qualify warning episodes and F27 email.
- [x] Implement and qualify bounded trends and frontend.
- [x] Complete local gates and integrated browser evidence.

## Rollout

Use the existing coordinated migration procedure: stop API/workers, apply
`0025_capacity_warnings.sql`, then start matching builds. Readiness requires this
head. Older readers cannot decode the new notice kind; any rollback must retain
head compatibility and notice decoding, rather than redeploying an old image.
No stored run format, role or execution-capacity policy changes.

## Qualification evidence — 2026-10-17

- PostgreSQL/API checks cover independent exact 80% crossings, bigint boundaries,
  reservations, audience, stale-mail refusal, purge and retention (including a
  row-lock/reactivation race). An observed resolved/reopened episode reuses its
  thread, and no unchanged scan increments it.
- Trends checks cover UTC midnight/microsecond boundaries, future exclusion,
  canceled reads, tenant/name fences, test exclusion, elapsed math and top-ten
  ties. A 48,000-summary fixture has 16,000 own and 32,000 foreign rows across
  120 days. Aggregating before filling empty bins reduced the daily query from
  141 ms to 11 ms locally. Final 90-day read: 27 ms; EXPLAIN ANALYZE: daily 11 ms /
  390 shared-buffer touches, rankings 4.8 ms / 392 touches. Both use existing
  workspace indexes with no sequential scan and the normal 2-second budget;
  no new index or rollup. A row-work budget guards against per-day history rescans.
  These are local measurements, not a throughput SLA.
- Local gates: full build/lint/types, dependencies, contracts/schema/architecture,
  9,490 workspace unit tests and 202 mocked browser journeys pass. PostgreSQL
  warning/audience/mail/upgrade/retention/trends checks and authenticated API reads
  pass; the updated Trends fixture also refuses unmocked server-error reads.
- The real browser/API/PostgreSQL Usage fixture passes at 1280px and 375px,
  including a genuine active-slots warning and 90-day summaries. Mocked journeys
  verify URL periods, all 90 chart bins, accessible exact data and phone keyboard
  scrolling. React Doctor: 100/100, no diagnostics on changed React files.

CI and merge receipts belong to the implementation PR. No production rollout,
paid service, external provider call or image download is included.
