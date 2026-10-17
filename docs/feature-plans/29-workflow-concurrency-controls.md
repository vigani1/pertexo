# F29 — Workflow concurrency

Status: Queue and Skip implemented; local qualification complete.
Updated: 2026-10-17. [Roadmap](../product-roadmap.md).
Decision: [ADR 058](../adr/058-workflow-concurrency-queue-admission.md), amended below.

## Outcome and current owners

A current workflow setting limits its runs across published versions. Existing
admission serialization, acceptance tickets, reservations and ordered promotion
remain authoritative. This increment adds **Queue** (default) or **Skip** to the
existing settings command; it does not add another scheduler or change workspace
capacity. Current code lives in database authoring/settings/concurrency,
runs/commands/acceptance, trigger admission, contracts, and web workflow settings.

## Decisions — 2026-10-17

- The overflow choice belongs to the workflow, not each trigger or version.
  Existing policies default to Queue. No limit means Skip has no effect.
- Under the existing workspace admission lock, Skip counts active-slot occupancy,
  reservations and already accepted queued runs of this workflow. Each run counts
  once. Counting queued admissions prevents simultaneous arrivals from both
  passing before a dispatcher reserves their slots. Existing backlog is not
  canceled when changing the setting. Ordinary timed waits occupy their slot;
  quiescent human waits release/reacquire it under ADR 076, unchanged.
  Cancellation/deadline settlement releases
  occupancy through existing transitions.
- Resolve exact accepted or skipped request replays before applying current
  policy. A skipped event never becomes a run when the same request is retried.
- Webhooks return 202 `{ skipped: true, reason: "concurrency_limit" }`, including
  response-mode webhooks. Authentication, endpoint eligibility, validation,
  deduplication, CORS and ingress limits still apply first.
- Schedules record a skipped occurrence with reason `concurrency_limit` and
  advance normally. Misfire skips retain their separate meaning.
- Forms commit a skip receipt and show “This workflow is busy. Try again
  shortly.” They keep the entered values. A new submission attempt uses a new
  idempotency key; an uncertain retry keeps the old key.
- Manual/API starts, replay and recovery return a typed 409 “This workflow is
  already running.” They create no run. Calls and draft tests keep queuing.
  Error-workflow intents are automatic triggers: record a visible concurrency
  refusal instead of silently dropping the intent or retrying it as queue-full.
- The existing append-only `usage_events` ledger records logical automatic
  skips under `trigger.skipped`, without event payloads, credentials or submitter identity. Existing
  webhook deliveries and schedule occurrences retain their native outcomes;
  this shared record supplies workflow skip history and usage accounting once
  per logical event. Exact replays do not increment usage. Retain these summaries
  for 90 days, matching ordinary run summaries; follow existing ledger scrubbing on workspace purge.
- Usage shows skipped trigger events separately from run totals in the selected
  retained-activity window. Skips are not failed or successful runs.

## Structure

- Database: extend the current concurrency policy with `overflow`; a focused
  runs admission helper owns the Skip decision and typed refusal. A triggers
  skip-record owner writes the bounded metadata used for history and usage.
- Existing trigger adapters translate that refusal inside their transaction:
  webhook replay/delivery, schedule occurrence, form receipt, error intent.
- Contracts/API: extend existing settings and trigger responses; add a bounded
  workflow skip-history read in the concurrency settings snapshot. Preserve authorization,
  CSRF, command revisions and idempotency. No public history endpoint.
- Web: use existing settings fields and Query ownership for Queue/Skip and a
  bounded recent-skip list. Public forms render the busy result without losing
  input. Existing delivery/occurrence lists explain the concurrency reason.
- Additive migration, Drizzle snapshot, existing forced workspace RLS, role grants,
  readiness/schema checks and retention/purge inventory change together. No
  table, package, service, role, CI job, queue or stored workflow format is added.

## Lock order

Admission preflight takes workspace/entitlement share locks, not the capacity
counter. The Skip check takes the existing admission counter only after the
request claim, variable revision and artifact-reference locks, immediately before
run insertion. Calls/test runs bypass this decision and retain their existing
counter order. Settings serialize on the same counter. Trigger adapters use a
savepoint around run acceptance: a skip rolls back its temporary acceptance
claim, then commits only the trigger receipt, native history and usage fact.

## Rollout

Migrate before the new readers/writers. A writer protocol fence refuses old run
writers for an enabled Skip policy; the database checks writer compatibility,
not the TypeScript decision. Deploy API/worker together with ingress quiesced
before selecting Skip. To roll back, change policies to Queue using new code
first. Existing reservations/backlog retain their ordinary lifecycle.

## Verification

- Real PostgreSQL races: concurrent arrivals, same/different workflows,
  active/reserved/queued occupancy, exact skipped/accepted replay, policy
  changes, terminal release, Calls/test exceptions and workspace limits.
- Real API/worker: signed and Secret URL webhooks, response-mode fallback,
  schedule advancement/restart and form busy/retry behavior. Assert no run,
  checkpoint or advance outbox exists for a skip; metadata and usage agree.
- Permissions, cross-workspace RLS, migration/protocol fence, bounded query
  plans, retention and workspace purge.
- Web units, mocked journeys and real desktop/phone settings/form flows;
  lint, types, unit, build, contracts/schema/architecture and React Doctor.
- One PR, green CI, rebase merge. No production deployment or image download.

## Tracker

- [x] Reconcile the current admission, replay and trigger owners.
- [x] Record decisions and amend ADR 058.
- [x] Implement persistence, admission, trigger receipts and usage.
- [x] Implement settings/history and public-form feedback.
- [x] Qualify real races and browser flows; record evidence.

CI and merge receipts are recorded in the implementation PR.

## Evidence — 2026-10-17

- Real PostgreSQL qualification covers admission races, native webhook/form/
  schedule/error receipts, separate skip statistics, existing queue behavior and
  workspace isolation. Migration fixtures preserve a prior limit/revision and
  default its overflow to Queue. The old-writer fence refuses incompatible inserts.
- Bounded retention removes expired skip summaries in pages, preserving recent
  skips and other usage categories; workspace purge scrubs skip facts through the
  existing ledger owner. Settings return only the latest 20 retained events.
- Eleven real webhook HTTP cases include signed and Secret URL skips. The real
  settings browser/worker fixture exercises Queue backlog, restart, manual 409,
  Skip and removal of the cap at desktop and phone widths. Screenshots were
  inspected at 1280px and 375px. Public-form busy/retry rendering is qualified
  with web units and mocked browser journeys; admission/replay uses real PostgreSQL.
- React Doctor: 100/100 for the 17 changed frontend files. Full units passed;
  all 198 mocked browser journeys, eight focused form journeys and the full
  repository check passed. No production rollout.

## Later

Separate workflow queue limits and per-trigger policies; business-key event
coordination is F25. Ordered start does not promise ordered completion or
external effects. Earlier Queue delivery history remains in Git (PR #138).
