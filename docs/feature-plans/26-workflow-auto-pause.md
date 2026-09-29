# F26 — Automatic pause of repeatedly failing workflows

Status: design accepted in [ADR056](../adr/056-workflow-auto-pause.md);
implementation slices 2 and 3 follow.
Created: 2026-09-29. Parent: [product roadmap](../product-roadmap.md).
Scope: New trigger control over existing run outcomes. Relative size: **L**, not a calendar estimate.

## Outcome

A workflow that keeps failing stops starting new runs on its own, tells the
people responsible why, and resumes only when someone chooses to. A broken
integration no longer burns runs, provider quota or downstream data for days.

## Current implementation and evidence

Schedules and webhooks start runs; people can enable and disable schedules, and
runs record terminal `failed`, `timed_out` and `outcome_unknown` outcomes.
[ADR055](../adr/055-workspace-inbox-failure-threads.md) already groups
failures per workflow for the inbox, and ADR 022 sends external failure alerts.
Nothing stops triggers because of failures.

Inspected anchors (paths may move):

- [docs/adr/048-schedule-fire-history-and-next-runs.md](../adr/048-schedule-fire-history-and-next-runs.md)
- [docs/adr/045-webhook-delivery-log.md](../adr/045-webhook-delivery-log.md)
- [docs/adr/055-workspace-inbox-failure-threads.md](../adr/055-workspace-inbox-failure-threads.md)
- [apps/web/src/features/workflow-settings/components/settings/lifecycle-section.tsx](../../apps/web/src/features/workflow-settings/components/settings/lifecycle-section.tsx)

“Not established” means no complete product was found in this targeted
inventory, not proof of absence. Recheck these anchors before implementation.

## Dependencies and planning gate

F03 for the notice that a workflow paused; F27 for the notice kinds and email
delivery of that notice. Can precede F09; F09's handled errors must not count
as failures once it exists.

Resolved in [ADR056](../adr/056-workflow-auto-pause.md), which takes the
recommended options below; resuming requires `workflow:publish`, held by the
same people as `workflow:update`, because it changes production admission
as ADR 034's archive and restore do:

- **Rule.** Consecutive terminal failures of triggered runs (recommended: 10,
  configurable per workflow within bounds), or a failure rate over a window
  (Zapier-style). Whether `outcome_unknown` counts, and that a success resets
  the streak.
- **What pauses.** Schedule and webhook triggers stop starting runs; runs
  already in progress finish normally; manual runs and replays still work so
  people can test a fix. A paused schedule records skipped occurrences as
  paused; a paused webhook answers with a distinct, documented status instead
  of silently dropping deliveries.
- **Paused versus disabled.** A system pause is its own state with a reason and
  time, separate from a person turning a trigger off, so resuming never turns
  on something a person turned off.
- **Warning first.** Optionally notify at a lower threshold before pausing.
- **Resume.** People with `workflow:update` resume; resuming resets the streak
  and is audited.

The failure streak must not be a counter updated in every run's transaction:
a noisy workflow would serialize its runs on that row. Evaluate it
asynchronously from terminal outcomes, as ADR055's fold does.

## User-configurable settings

Recommended values, confirmed in this feature's ADR. The server enforces every
range; the control states its consequence.

| Setting | Default | Range | Who changes it | Consequence shown |
| --- | --- | --- | --- | --- |
| Pause after failures in a row | 10 | 3–100 | Workspace admins set the default; workflow editors override per workflow | “Schedules and webhooks pause after N failed runs in a row; runs in progress finish” |
| Auto-pause for this workflow | On | On or off | Workflow editors; turning it off is audited | “This workflow keeps starting runs however often it fails” |
| Warn before pausing | On, two failures early | On or off | Workflow editors | “Eligible readers get a notice before the pause” |

## Ownership and structure

Database streak evaluation and pause state; worker evaluator loop; trigger
admission for schedules and webhooks; contracts; web workflow settings, run
history and inbox notice.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).

## Frontend work

A paused banner on the workflow with the reason and a Resume action; the pause
rule in workflow settings; paused schedule occurrences and refused webhook
deliveries visible in their histories; the inbox notice links to the workflow.

## Backend work

A bounded evaluator that reads terminal outcomes per workflow, applies the
rule, and records pause state and reason atomically with a notice source;
schedule and webhook admission that honors the pause; resume command with
audit; readiness and metrics for the evaluator.

## Delivery slices

1. ADR for the rule, pause state, webhook response and resume semantics.
2. Pause state, evaluator and trigger admission with real-database tests.
3. Resume command, settings rule and web banner; inbox notice once F27's
   notice kinds exist.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

A burst of failures pauses exactly once; a success resets the streak;
concurrent terminal runs never double-pause; in-flight runs finish; a paused
schedule skips and records occurrences; a paused webhook refuses clearly;
manual runs still start; resume restores only what the pause stopped; a person's
own disable is never undone; the notice reaches eligible readers.

## Non-goals

Pausing because of cost or quota (F12/F23), automatic resume, and retrying the
runs a pause prevented.

## Rollout and rollback

Ship the evaluator in observe-only mode first (would-pause metrics, no pause),
then enable per workspace. Disabling the evaluator stops new pauses; existing
pauses stay until resumed.

No production rollout, paid provisioning or real external calls are authorized
by this plan.

## Competitor context

Zapier turns a Zap off automatically when it errors on 95% of runs and has run
more than 20 times in the past 7 days, with an emailed grace period on Team and
Enterprise plans ([Zap is not running](https://help.zapier.com/hc/en-us/articles/8496216132621-Zap-is-not-running)).
Make deactivates a scenario after a configurable number of errors in a row, and
immediately on the first error for instant triggers
([scenario settings](https://help.make.com/scenario-settings)).

Research checked 2026-09-29; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation.

## Delivery tracker

- [x] Baseline reconciled against current code and accepted decisions.
- [x] Product choices resolved; necessary ADR accepted (ADR 056).
- [ ] Contracts and failure/security model reviewed.
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [ ] Real integrated acceptance evidence recorded.
- [ ] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

Evidence log:

- 2026-09-30: baseline checked against `app.schedule_claim_is_eligible` and
  the occurrence outcomes of ADR 048, webhook ingress order (ADR 026) and
  delivery outcomes (ADR 045), trigger and lifecycle gates (ADR 034), the role
  policy and run trigger types; ADR 056 records the decisions.
