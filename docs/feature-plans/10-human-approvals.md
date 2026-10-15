# F10 — Durable human approvals

Status: implemented and rebase-merged in #301; natural main CI green.
Updated: 2026-10-15. Parent: [product roadmap](../product-roadmap.md).

## Outcome and scope

An Approval step creates one durable task for its exact run and invocation.
An eligible workspace member approves or rejects it once, optionally comments,
and the run continues through that output port. No worker waits, browser timer
owns expiry, email is sent, or public decision capability is created.
F11 will add request-input tasks to this same concrete pending-task owner.

## Current code and decisions

The current engine already separates a successful Call declaration attempt from
its logical durable outcome (`workflow-engine/observation/coordinator-calls.ts`).
The database persists that declaration, checkpoint and outbox in one transaction;
Call results are separate immutable facts. Timed Wait has a database-authoritative
due-node scanner and immutable attempts. Human decisions do not exist. Configured
run deadlines are bounded by an hour (an absent budget means no deadline), queue/capacity counts include ordinary waiting
runs, and input expiry can remove an otherwise live ordinary run's input after
30 days. These must be handled rather than inherited accidentally.

The recommended choices below are accepted under the owner's instruction to
choose and record internal decisions. Record the durable interaction contract
in ADR 076; amend ADR 021 only to clarify that timed Wait remains unchanged.
No new role, package, database entry point, queue, service, CI job, provider or
infrastructure is required.

### Step and audience

- Definition `core.approval@1`, `nodes-core/src/flow/approval/`, safe CPU
  declaration executor with `in`, `approved` and `rejected` ports. Its initial
  declaration is not a completed logical step and cannot activate successors.
  The browser catalog exposes only the logical decision output, so Insert data
  offers decision/comment/actor/time instead of an internal pending marker.
  Defaults are materialized in editor configuration before publication, matching
  the existing portable policy that refuses implicit schema transformations.
- Strict config: title (1–160 characters), optional instructions (up to 2,000),
  expiry seconds (default 604800, 3600–2592000), and a bounded audience of roles
  and/or named member IDs (at most 50 IDs). Default roles are owner and admin;
  an empty audience is invalid. No escalation, reassignment or all-person vote.
- Audience membership is evaluated when listing/deciding, against current active
  workspace, user and membership. A named member grants no run-read capability.
  Publication verifies named members belong to this workspace. Portable imports
  retain explicit member references but cannot publish until editors replace any
  foreign or removed audience; never silently substitute an approval policy. Role changes can
  change eligibility; a stale browser cannot authorize a decision.
- The authenticated person who starts a run cannot decide its tasks. Record
  `started_by` at common admission. Browser and automation-token starts bind
  their actual actor, Calls inherit their initiating human, replay/recovery bind
  the new initiating human. Operator replay, which lacks a workspace human
  identity, preserves the source starter rather than dropping this restriction. Scheduled/webhook/error starts have no human starter.
  Do not infer identity from user-supplied run input or free-form audit text.
- Output is `{ decision: "approved" | "rejected", comment: string | null,
  decidedBy: UUID, decidedAt: ISO timestamp }`. Comment is optional, up to 2,000
  characters, plain text. All ordinary authorized run readers can inspect it as
  step output; the form states this. Selected branch is engine-owned metadata,
  never inferred from an arbitrary output property.

### Durable task and decision

`database/src/runs/pending-tasks/` owns creation, current eligibility, atomic
resolution, expiry, immutable result projection and cancellation. Use one
workspace-scoped `pending_run_tasks` table, unique on workspace/run/invocation,
with exact version/node identity, captured audience/config, database-created
expiry, status, decision/result and consumption. Only the approval kind is
accepted now; add request-input when implementing F11, not an open generic plugin
payload. Workspace/run/node foreign keys, forced RLS and existing three roles.

A small successful attempt validates and declares the request. The pure engine
turns that declaration into `human_task` waiting state, with a task intent in the
transition plan. Creation, logical wait and checkpoint share one commit. Task
outcomes reach the pure engine through a bounded typed observation window, like
Calls, and a task-owned output reference. The database projects that result into
the ordinary node output for downstream mappings, history and callable results.
A decision never rewrites the declaration attempt or feeds untrusted events into
the run's persisted cursor.

Decision uses existing cookie authentication, CSRF, bounded JSON, rate limit and
idempotency command receipts. Lock workspace admission, current authority, run,
then task in the documented order; require the run still live and uncanceled and
database time strictly before expiry. A single transaction records one winner,
audit and the normal coordinator outbox. Same-key retries return the recorded
result; competing decisions get a typed already-decided conflict. Lost responses
retain the browser command/key for explicit retry. Membership loss and initiator
self-decision fail closed without resolving anything.

Expiry is a definite `pending_task.expired` failed step, not rejection and not a run
wall timeout. It goes through existing failure-route selection; an attached
handler can settle it successfully. Existing F09 tree rules learn Approval's two
normal ports, without enabling unrelated joins/loops in failure-route graphs.
Extend the failure-value allowlist with exact human-task expiry/capacity pairs,
separately from executor/provider classifications, and amend ADR 073. Step
recovery remains unavailable for graphs containing human tasks until it has
explicit durable decision-prefix evidence; full replay creates fresh tasks.
The regular due-node scanner owns an expiry wakeup; duplicate delivery cannot
resolve or resume twice. Cancellation/terminal Stop closes pending tasks and
clears due markers. A decided task may remain as history even if cancellation
subsequently wins run control; it never reopens.

### Time, capacity and retention

### Deadline clarification from current admission code

The optional caller deadline is an absolute wall deadline, while the published
`maxRunDurationMs` is an execution budget. Preserve the caller deadline separately:
human waiting pauses only the execution budget, with operational deadline equal
to the absolute deadline while paused. A caller deadline still cancels waiting
on time; a run originally without a budget stays unlimited. Calls inherit the
parent's absolute deadline separately from its temporary execution deadline, so
an inherited one-hour budget never becomes an accidental seven-day approval cap.
Existing Call slot handoff remains: the parent regains its slot when the child
finishes; a long human wait releases the shared workspace slot, and each suspended
ancestor must satisfy its workflow cap before child work resumes.


Quiescent human waiting pauses the remaining execution deadline and releases the
active-run slot, while preserving status `waiting`. Ordinary timed Wait/retry
semantics remain unchanged. Persist the remaining deadline budget and human-wait
start in the run row. An originally unlimited run retains a null remaining
budget and resumes without inventing a deadline. Shared `workflow_run_slot_counts` excludes suspended human
waits; the existing admission trigger/counters enforce resume capacity too.
Releasing slots must not create an unbounded human-task queue: the workspace's
existing queued-run allowance also bounds outstanding pending human tasks (100
under the default entitlement), checked under the same workspace admission lock.
A declaration above that budget becomes a definite `pending_task.capacity_exceeded`
failed step through the normal task fact, with a clear wait/try-later message;
it does not fail source settlement or add a new configuration knob. Lowering an
allowance preserves existing tasks and blocks new ones until below the bound.
Decision resolution does not bypass capacity: a ready continuation reacquires a
normal slot, using existing bounded outbox deferral when full. Cancellation and
expiry can settle without a slot; they do not need to start worker attempts.

For parallel/loop scopes, suspend only when no ready/running/timed work remains
and all outstanding executable work is waiting on human tasks (loop and pending paired-Merge barriers are
structural). An active sibling keeps the deadline and slot. Graph pruning and Stop also close
any pending task in the pruned scope; late responses cannot resurrect it. For Calls, propagate
quiescent human waiting through the existing parent/child relation using normal
wakeups; each ancestor changes only under its own lock. Resume restores remaining
budgets and normal Call slot handoff. Add explicit nested-Call proofs so a seven-day
task cannot accidentally inherit the old one-hour Call deadline.

Already declared, unstarted sibling Calls share their parent's human pause:
restore their remaining recorded deadline when the parent resumes, bounded by
its restored budget and absolute deadline. Do not revive a Call whose deadline
had already expired before the pause. Accepted children keep their own durable
paused clocks and their immutable Call identity.

Retain live run input and referenced files while a pending human interaction or
its live continuation needs them; ordinary terminal retention still owns cleanup.
Tasks and comments follow run-detail retention and workspace purge, with no new
independent indefinite retention. Removed memberships lose task eligibility;
retained decision identity is audit history, never an access grant.

## Placement and interface

- `workflow-model/src/pending-tasks/`: browser-safe config, output, roles, limits,
  definition identity and expiry reason; exports through existing root. Keep
  workspace authority in database policy rather than duplicating role rules.
- `nodes-core/src/flow/approval/`: strict schemas, declaration executor/manifest;
  existing catalog registration and editor presentation/defaults.
- `workflow-engine/src/observation/`: task declaration/outcome projection; existing
  transition/checkpoint/output-reference parsers learn this exact control kind.
  Pure engine owns branching and failure handling; no database/time I/O in it.
- `database/src/schema/runs/`: additive task/run columns plus generated migration,
  RLS/grants and readiness/schema checks. `runs/pending-tasks/` groups command,
  facts/persistence, audience and deadline/capacity responsibility; split an area
  before it becomes a flat list. Expose through existing `/runs`.
- `contracts`: task list/detail/decision requests, typed refusal/conflict problems
  and OpenAPI. `apps/api/src/pending-tasks/`: one Nest module/use case/controller
  composed with existing tenant context and request operation signal. A small paginated audience
  discovery returns active member IDs/names/roles for workflow editors, without
  exposing the privileged team directory or email addresses.
- Worker/execution: existing coordinator and scanner ownership, no sleeping
  attempt, new queue or separate task polling service.
- `apps/web/src/features/approvals/`: API/query/mutation ownership, list/detail and
  decision form, narrow `public.ts` integrations. Authenticated workspace route;
  inbox and run detail compose a small pending-task projection. Current failure
  inbox permission stays separate from task audience, so named builders/viewers
  can discover their own tasks without receiving privileged failure threads.
- Editor uses existing inspector primitives and mapping controls. Approval shows
  its audience, expiry and self-decision rule. Weft Status/thread language,
  semantic labels, keyboard access, mobile width, reduced motion; no new visual
  system or client mirror of authoritative task status.

## Verification and delivery

One focused F10 PR after Error workflows merges. The shared workspace authority
fence moved from authoring to tenant access in its own buildable commit
(`f1fe45672`); workflow-specific error translation stays with authoring. Commit gates are lint, typecheck and
units; PR includes Moved/Removed/Lines, full mocked e2e, real database/worker/browser
proof, green CI and rebase merge. Update this tracker with actual receipts.

- [x] Reconcile current code; record choices and accepted ADR before building.
- [x] Catalog/model and pure engine task lifecycle, branch, expiry failure route.
- [x] Additive storage, authority/initiator binding, idempotent one-winner command,
      cancellation/purge/retention and restart-safe ordinary outbox delivery.
- [x] Deadline and capacity behavior, including active siblings, capacity-one
      resume and nested Calls; no work admitted while a slot is unavailable.
- [x] Editor, eligible approvals list/detail, inbox/run links and accessible
      decision/comment feedback with unknown-response retry.
- [x] Real races: approve/reject, same-key duplicate, expiry/decision, cancellation,
      role/member loss, cross-workspace IDs, process restart and exactly one resume.
- [x] Real browser/API/worker approve and reject paths; expiry handled by failure
      route, starter refused; desktop/phone/keyboard and independent SQL checks.
- [x] Lint/types/units/build, contracts/schema/architecture/dependencies, mocked e2e,
      changed React Doctor, owned fixture cleanup; record exact evidence.
- [x] PR green, rebase merged and natural main result inspected.

### Merge evidence (2026-10-15)

PR #301 rebase-merged as `e871b8cc618e5ae7aafb141a78edac1b7c788600`.
Updated-head CI `38713571613` passed all required jobs, including the complete
real-stack browser job with Approvals. CodeQL `38713571748` passed. Natural main
CI `38716308362` passed, including native ARM image publication; its CodeQL
run `38716308497` also passed.

### Local integrated evidence (2026-10-15)

- Full lint, TypeScript, format, build (real and mocked browser harnesses),
  units, contracts/OpenAPI, schema (86 typed tables), architecture and Knip
  passed. All 169 mocked e2e cases passed; changed React Doctor 100/100.
- PostgreSQL: 63 cases across tasks, authority/decision races, publication
  membership checks (including loop bodies), retention, purge, coordinator
  observations and Error-workflow regressions.
- Real Redis/PostgreSQL worker: seven cases cover approve/reject after restart,
  expiry handled through a failure route, nested capacity-one Calls, cancellation,
  final Approval callable output, dormant slot return under competition, and
  pending parallel sibling Call deadlines across human waiting.
- Pure engine: 11 task cases include loop pruning and parallel Merge quiescence.
- Existing Call execution/control group: all 14 cases passed. The five-parent
  case timed out during concurrent browser/build checks; an isolated focused
  rerun passed, then the complete group passed in 36 seconds. No assertion or
  timeout was weakened.
- Real API/worker/browser: starter refused; a named viewer approves at 1280px
  and rejects at 375px using keyboard controls; independent SQL proves exactly
  two declarations, terminal continuations and comment-free audit metadata.
  Inspector empty instructions and invalid title preserve normal editing.
- CI caught a previous Call-retention assertion that expected a live unrelated
  child input to expire. It now proves live input remains, and expires after
  terminal completion, matching the explicit human-wait retention policy.
- The existing real-stack browser CI job includes the `approvals` journey; no
  new job or infrastructure was added.
- Screenshots: `docs/media/approvals/` contains desktop/mobile before and after.
  The harness used the attested CI fixture on ports 56432/56389/59090 and
  disposed its own databases, Redis namespace and Vite process. Owner development
  services and the shared fixture containers remain untouched.

## Rollout and rollback

Deploy matching API and worker binaries before publishing the first Approval.
Older workers must fail closed on the new definition/control facts. Rollback
requires completing or canceling pending human runs and retaining compatible
readers until their history is no longer served; do not imply an unimplemented
feature flag can make old workers understand new checkpoints. No deployment or
external service provisioning is part of this implementation request.

## Later work

Email/public approval links, multiple required votes, delegation/escalation,
reassignment, approvals from outside the workspace and file fields remain out.
F11 request-input reuses the pending-task mechanism in the next authorized feature.
