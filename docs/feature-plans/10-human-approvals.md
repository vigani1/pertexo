# F10 — Durable human approvals

Status: delivered baseline, including captured context and starter choice.
Requested editor/list follow-ups are implemented; release is gated on PR CI.
Updated: 2026-10-16. [Roadmap](../product-roadmap.md).
Decision: [ADR 076](../adr/076-durable-human-tasks.md), with the dated amendments.
History stays in git and PRs.

## Decisions

An Approval declares one durable task for its exact run/invocation. An eligible
member approves or rejects once; the decision selects that output path. Reuse
one pending-task owner for approvals and F11 requested input, the ordinary
coordinator/outbox and the existing three database roles. No sleeping worker,
public decision link, email decision, new queue or service.

The captured per-step `allowStarterToDecide` defaults off. Absence remains absent
in old portable configuration. Explicit true removes only starter exclusion,
not current authority, audience, lifecycle or one-winner checks.

## Rules

- `core.approval@1`: title 1–160 characters, plain instructions up to 2,000,
  roles/named-member audience with at most 50 IDs, seven-day expiry by default
  (one hour–30 days). Default deciders are owners/admins; empty configured
  audiences are invalid. Publish fences named members to this workspace.
- Current active workspace/user/member and run-read authority are required at
  discovery and decision. `runs/pending-tasks/eligibility.ts` owns the shared
  audience/starter rule for task lists, locked decisions and notice/mail access.
  Role changes and removal take effect immediately; naming grants no capability.
- Bind the real starting person at common admission. Calls inherit that person;
  authenticated replay/recovery bind their new initiator. Operator replay retains
  the source starter. Automated/public starts may have no human starter. Never
  infer a person from run input or audit text.
- The editor's current all-member audience count warns when an excluded starter
  would be the only eligible decider; it also explains an empty current audience.
  This is advisory. Do not infer eligibility from a directory's first page.
- Map at most 20 named details from earlier steps, within 8 KiB. Each value
  is a plain scalar or a list of at most 20 plain scalars; no nested values. Capture
  details once when the task opens, separately from its static instructions.
  Show them only on eligible authenticated task/Inbox reads; never notice email,
  stream hints, audits or error-workflow summaries. Plain text, no HTML.
- A short safe declaration attempt is not logical completion. Task creation,
  wait intent and checkpoint commit together. The pure engine consumes durable
  task outcomes and selects the path; it does not poll the database or clock.
- A decision locks current authority, run and task in established order. Require
  a live uncanceled run and database time strictly before expiry. Record one
  winner, optional comment up to 2,000 characters, output, audit and normal wake
  atomically. Exact idempotent retries return that result; competing decisions
  cannot replace it. Preserve the exact browser command after response loss.
- Output records decision, nullable comment, decider UUID, captured display name
  (up to 256 characters) and database timestamp. Later profile changes cannot
  rewrite it. Old outputs may lack a name; preserve their legacy display fallback
  without inventing historical names. Normal authorized run readers see output.
- Expiry is definite `pending_task.expired`, not rejection. Capacity refusal is
  `pending_task.capacity_exceeded`; both use existing allowlisted failure paths.
  Cancellation, Stop and scope pruning close pending tasks; late replies cannot
  resurrect them. Declaration attempts remain immutable.
- Only quiescent human waiting releases the active slot and pauses the remaining
  execution budget. Active siblings keep both running. An absolute caller
  deadline still applies; an unlimited run remains unlimited. Timed Wait/retry
  behavior stays unchanged. Calls propagate quiescence and retain slot handoff,
  nested paused clocks and unstarted sibling deadline budgets.
- The existing workspace queued-run allowance bounds outstanding human tasks
  (100 by default). Lowered limits preserve existing tasks and refuse new ones.
  Ready continuations reacquire ordinary capacity; expiry/cancel need no slot.
- Retain live input, variable references and files while needed by human waiting
  or continuation. Tasks/results retire with run details and workspace purge.
  F09 step recovery excludes human-task graphs; full replay creates fresh tasks.

## Ownership and slices

| Slice | Owner and status |
| --- | --- |
| Configuration, output and safe declaration | workflow-model and nodes-core; complete |
| Waiting, outcomes and branch selection | pure workflow-engine; complete |
| Durable task, authority, clocks/capacity and retention | database/runs/pending-tasks; complete |
| Authenticated commands and audience inspection | API/pending-tasks; complete |
| Editor, Approvals/Requests pages, Inbox/run composition | web/features/pending-tasks; complete |
| Captured details, default-off starter choice and immutable name | Complete (#305, #311) |

Qualification covers one-winner/idempotency races, expiry/cancel, changed roles,
legacy configuration/output, capacity-one and nested Calls, retained context,
more than 50 audience members and real desktop/phone approve/reject journeys.
Full checks, mocked e2e, React Doctor and green CI precede rebase merge.

## Follow-up decisions (2026-10-16)

Approval and Request input share Setup label/value rows, normal Insert data/source
controls and advanced expressions. Literal lists use the normal JSON value
control. Whole-object mappings remain editable in Inputs, preserved unchanged.
Store ordinary literal objects or JSONata, using the already pinned parser for
browser syntax/object recognition only, never browser evaluation or editor-only
stored metadata. Run input, linked step output and captured variables retain the
normal expression context; evaluation and immutable bounds stay server-owned.

Qualification covers add/edit/remove, typed and mapped values, advanced mapping
preservation, reload, keyboard/phone layout, captured lists and authorization.
No new service, role, package or mapping format. Matching readers precede list
writers. [F11](11-forms-and-resume-input.md) shares the controls for prefills.

## Rollout and later work

Use the existing coordinated deployment for task schema/clock changes. Matching
API/worker output readers must precede new name writers; strict old readers must
not consume newer output. No destructive rollback across persisted task data.
Reassignment, escalation, public links, voting and human-task prefix recovery
remain later work. See the [approvals guide](../guides/approvals.md).
