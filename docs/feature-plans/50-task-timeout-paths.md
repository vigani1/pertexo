# F50 — Timeout paths for approvals and input requests

Status: approved by the owner on 2026-10-26 (recommended options delegated).
Delivery: one of four features combined in `feat/spreadsheets-attachments-and-task-timeouts`.

## Outcome

When nobody answers an **Approval** or **Request input** in time, the workflow
can continue down a visible **Timed out** path instead of failing. Builders can
escalate (notify a manager, reassign the work in another step), take a default
decision (link the path to the approved or rejected branch), or end cleanly.

Benchmarks: Zapier's approval steps continue or stop when time runs out, and
n8n's wait-for-response nodes have timeouts that route on. Pertexo keeps its
existing expiry and makes the outcome a first-class path on the canvas.

## Current owners

- Steps: `packages/nodes-core/src/flow/approval/` (ports `approved`, `rejected`)
  and `packages/nodes-core/src/flow/request-input/`. Config schemas come from
  `packages/workflow-model` (`approvalConfigSchema` and friends).
- Engine: `packages/workflow-engine/src/observation/coordinator-tasks.ts` turns
  task facts (`approved`, `rejected`, `submitted`, `expired`, `refused`) into
  outcomes. An expired task currently fails the step with `pending_task.expired`.
- Failure routing: `packages/workflow-model/src/flow/failure-routing/`. An
  attached failure route already catches `pending_task.expired`.
- Storage: pending tasks in `packages/database/src/runs/pending-tasks/`.
- Guide: `docs/guides/approvals.md`, which lists escalations as later work.

## Decisions

- **One new optional output port, `timed_out`**, on Approval and on Request input.
  The setup gains **When nobody responds**:
  - **Fail the step** (default; today's behavior, `pending_task.expired`); or
  - **Continue on the Timed out path.**
  The port appears on the canvas only when the second option is chosen, so
  existing workflows look and behave the same.
- **Default decisions stay explicit.** There is no hidden "auto-approve". To
  treat silence as approval, the builder links Timed out to the same next step
  as Approved, which shows on the canvas. The guide shows this pattern and the
  safer escalation pattern.
- **Output on timeout:** `{ timedOut: true, expiredAt, openedAt }` plus the
  captured context, so later steps can mention who was asked and when. Keep it
  JSON-shaped like the other task outputs, and add it to the output schemas
  (a union with the existing decided outputs).
- **Engine:** an `expired` fact on a node whose config chooses the Timed out
  path becomes a successful outcome on port `timed_out`. Otherwise nothing
  changes. `refused` (capacity) still fails, since that's not a timeout.
  Cancellation, late decisions after expiry and restart recovery keep their
  current rules. A late decision can't revive a timed-out task.
- **Expiry window** stays as today (1 hour to 30 days, default 7 days).
- **Validation:** publishing with Timed out chosen but nothing linked is allowed,
  like other unlinked outputs, and the F28/#528 unlinked-step warnings apply to
  whatever is linked after it.
- **Versioning and stored data:** follow the repository's rules for adding a
  port and a config field to existing node versions. Existing published
  versions must keep failing on expiry. If a new node version is needed, add
  it the way earlier node upgrades did. No migration of stored runs.
- **Inbox:** an expired task already leaves Inbox. Nothing new there.

## Editor and design

- **Canvas:** the Timed out port gets its own quiet identity: an hourglass or
  clock glyph and a muted amber line style, distinct from the success green and
  failure red, matching how the Weft canvas already styles Failure. Its label
  never clips (see the #528 Failure-label fix).
- **Inspector:** the expiry setting becomes a small **timeline**: "Opens when
  the run reaches this step → expires after 7 days", with a slim arc or bar
  showing the window. Under it, the When nobody responds choice is a pair of
  clear cards with one-line consequences ("The run fails with *expired*" vs
  "The run continues on Timed out"). Not a plain dropdown.
- **Run detail:** a timed-out task shows "Timed out after 7 days" with the same
  glyph, and its path is highlighted like any other taken branch.
- **Inbox and task page:** an open task shows "Expires in 2 days" as a calm
  countdown in the existing detail style.
- Check it at every size in the brief (360 to 1920 px), light and dark, with no
  layout shift.

## Tests

- Model and unit: config schema, port presence, and output union.
- Engine: expiry → `timed_out` outcome when chosen, and still failure when not.
  Capacity refusal, cancellation and late decisions are unchanged. A restart
  during expiry is handled.
- Database integration: the expiry sweep, settling a timed-out task without a
  worker slot, and a downstream step on the Timed out path running afterwards.
- Web: inspector cards and timeline, port appearing and disappearing, run detail.
- Live journey: an approval with a short expiry (the test-time minimum the
  existing journeys use, or a test clock) expires and the run continues on Timed
  out to a later step. A second approval without the option fails as before.

## Out of scope

Reminders before expiry, reassigning the open task, multi-person voting,
delegation and public approval links.
