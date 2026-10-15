# F27 — Personal notification preferences and notice kinds

Status: implemented and locally qualified. Recommendations below were accepted
under the owner's instruction to choose, document and continue. GitHub PR checks
and natural-main image publication remain the release gates.
Updated: 2026-10-15. Parent: [product roadmap](../product-roadmap.md).
Decision: [ADR 079](../adr/079-personal-notices-and-mail.md).

Follow-up (2026-10-15, implemented): show the task's captured bounded details on
eligible Approval notices, using the existing task context projection. Requested
input Inbox rows show the same details. Email, stream hints, audit and error
workflow summaries remain free of task data; task eligibility gates context.

## Follow-up: one audience owner (2026-10-15)

Status: implemented and locally qualified under the owner's instruction.

`inbox/eligibility.ts` owns one query predicate used before list/mail limits,
summary/revision counts and single/all read commands. It derives role audiences
from the existing TypeScript capability policy and combines them with current
membership, follow, mute, the current attention flag and the failure window.
Approval notices reuse `runs/pending-tasks/eligibility.ts`; task queries and
locked response commands share that owner. Mute affects notices only.

Move the existing task predicate out of row projection in a separate commit,
without changing behavior. Then replace the JavaScript mail post-filter and
persistent `workspace_notice_visible` business function with the shared
TypeScript-owned predicate. SQL RLS keeps workspace and active
workspace/user/member fences; private preferences/read state remain fenced.
Keep trusted worker operations within their existing workspace scope.

Migration weakens the old SQL business filter, so stop older API/worker readers
before applying it and start only matching binaries. Use a coordinated restart
on the existing server, with no new role, service, format or deployment mechanism.
No reader may rely on the removed SQL audience rule.

Qualify role/follow/mute/task changes, suspended/foreign readers, filtering before
pagination and mail's 100-subject cap, unread/revision/read commands, immutable
context visibility and populated upgrade. Required checks and existing CI must
pass before rebase merge.

Local proof: each commit passed full checks and 9,192 unit assertions; the
move passed 36 PostgreSQL cases, and the completed policy passed 57. All 178
mocked browser cases and the real notification/API/worker/SMTP journey passed.
A foreign workspace containing notices and a suspended member remain fenced in
raw SQL; business-ineligible current members are filtered by the application.

## Current code and outcome

F03 already has one workspace inbox: terminal failure events are folded into a
workflow thread, with private read revisions and content-free Redis hints. F10
and F11 provide durable human tasks; F13 provides the shared workspace API scope
and retained-command helper. F26's pause fold, F12's capacity projection and the
connection-health owner already persist authoritative attention facts. Reuse
these owners. No infrastructure, account, role, package, transport or CI job is
needed. ADR 022's shared workflow alerts remain independent of personal choices.

Current anchors:

- `database/src/inbox/{producer,fold-store,read-store,failure-days}.ts` and
  `schema/inbox/core.ts`; accepted F03 SQL fold/recipient policies.
- `runs/pending-tasks/eligibility.ts`: one audience/blocked predicate for tasks.
- `triggers/pause/fold-store.ts`, `connections/health/`, and
  `runs/queries/usage-capacity.ts`: authoritative source facts.
- `database/src/platform/mail/store.ts`, worker
  `mail/{delivery,runtime}.ts`, and integrations
  `system-mail/`: durable encrypted mail and existing SMTP/Resend delivery.
- API `notifications/`; web `features/inbox/`, the workspace Inbox route and
  workflow Settings and connection detail. Extend these; do not introduce a parallel inbox.

## Product decisions

| Choice | Recommended behavior |
| --- | --- |
| Personal email | Inherit workspace default, Off, immediate, hourly or daily |
| Workspace default | Off initially; owners/admins manage an explicit capability |
| Daily schedule | 09:00 initially; hour 0–23 and validated IANA zone, including UTC |
| Immediate | First update promptly; at most one batch per person/workspace/UTC minute |
| Hourly | One current-changes digest at/after the next UTC hour |
| Daily | One digest at the chosen local hour; missing hour uses first valid later time, repeated hour once |
| Outage | One catch-up digest of current changes; no mail per missed window |
| Follow | Join a workflow's audience using run-read access; grants no other capability |
| Mute | Private workflow/connection choice; independent of follow and shared alerts |
| Unsubscribe | Confirmation page and scoped POST, without sign-in; only personal email becomes Off |

Email begins with future changes after enabling it, following/unmuting a subject
or changing an inherited default. The Inbox still shows eligible retained
threads. Choosing a timezone/hour does not rewrite notice history. New notice
mail is disabled with a clear reason when durable system email is unavailable;
local authentication-link display alone is insufficient. Turning email Off
always remains available. Reuse `AUTH_MAIL_FROM`, `AUTH_MAIL_KEY` and its versioned
key ring, `PUBLIC_WEB_ORIGIN`, and the existing transport/provider variables.
The worker needs the existing sender/origin values to prepare notice mail.

### Notice kinds and audiences

| Kind | Subject and source | Audience |
| --- | --- | --- |
| Workflow failure | Workflow; existing terminal failed/timed_out/outcome_unknown fold | Existing owner/admin/operator audience, plus followers |
| Auto-paused workflow | Workflow; actual current trigger-pause revision | Same workflow audience |
| Connection needs attention | Connection; actual reauthorization-required health revision | Owners/admins |
| Limit reached | Workspace; current queue/artifact byte/count capacity episode | Owners/admins/operators |
| Approval waiting | Pending approval task | Current eligible deciders; starter excluded unless the captured step permits |

Canceled runs and failures handled by a route do not become workflow failure
notices. Existing unknown-outcome behavior stays. Active-run slots being full is
ordinary queueing, not a capacity notice. Pending input requests remain in the
Requests section; they are not a new email kind in this feature.

Mute applies to all notices associated with that workflow, including waiting
approvals; it does not cancel or hide the task from its task list. Following does
not implicitly unmute. Existing Requests Inbox content becomes input-request
only; the unified approval notice supplies one approval card, with the normal
authenticated task detail and Approvals list as authority. No duplicate cards,
email decisions, public approval links or extra approval mechanism.

## One inbox, bounded observation

Generalize existing threads and private reads to UUID thread identities and one
unique `(workspace, notice kind, subject ID)`. Every subject is a UUID: workflow,
connection, task or workspace. Explicit nullable subject FKs and checks preserve
workspace identity. Keep failure terminal status as its detail, preserve failure
lanes/counts and migrate populated read state. Failure events remain failure-only
aggregation input; do not build a generic event bus.

Current operational attention is reconstructed by an observation pass in the
existing inbox polling runtime. Discover at most 100 candidates with keyset
continuation from current source facts and unresolved threads. Use the existing
maintenance connection for bounded candidate reads, then scoped app transactions
for source checks and thread updates. No new broad app-role grant or role. Keep
workspace/source/thread lock order consistent and never hold a transaction over
network delivery. Candidate cursors continue through no-change pages.

One observation writer compares the current source revision/active state under a
subject fence. Concurrent workers create one occurrence; repeat polls do nothing.
Resolution advances the thread revision without adding an occurrence. Limit
observations coalesce a current saturation episode; count changes while the same
limit stays reached do not generate notices. Brief transitions between polls are
not claimed as an exhaustive event history. In particular, never record a notice
inside the transaction rolled back by an admission quota error, or add a
fire-and-forget write after a refusal.

Resolved operational threads stop appearing as current attention. Failure threads
keep their existing 30-day behavior. API list/summary/read commands and mail use
one current eligibility owner; reuse the pending-task eligibility predicate,
never copy its starter/audience/expiry rules. Preserve forced workspace RLS and
private reader state; following grants only subject visibility. Inbox endpoints
and streams become workspace-readable while row eligibility remains precise.
Content-free hints carry no private choice or notice payload.

## Preferences and commands

Add only records serving current behavior: workspace email defaults, personal
preferences, private workflow/connection subscription choices, and bounded mail
batch/item witnesses. No per-person notice fan-out at production time. Absence
projects defaults; a worker-created default preference can remain revision zero
so background scheduling does not cause a false Settings conflict.

Settings/defaults and each subject choice have their own CAS revisions and exact
idempotent commands. A mute/follow does not overwrite or unnecessarily conflict
with an unrelated Settings draft. Current authority is checked before receipts
are replayed. Commands use session/CSRF boundaries; no automation-token scope is
added. Default management adds an explicit owner/admin capability to the existing
policy, not a new role.

The existing `updateMembership` command boundary deletes private preferences,
subscription choices and reads on removal/departure. Suspension preserves choices
but stops visibility/delivery. Rejoining starts fresh. Workspace purge removes
linked personal mail before its batches/subjects and uses the existing lifecycle
owner; no orphan sealed mail remains. Normal detail retention stays bounded.

## One durable mail queue

Move/rename TypeScript ownership from authentication-specific mail to a small
system-mail module in a separate mechanical commit. Keep its physical table,
legacy authentication AAD/idempotency identities, ciphertexts and current auth
behavior. Generalize the existing worker handler/runtime; use the existing queue,
leases, generation/token settlement, retry bounds and SMTP unknown reconciliation.
Security mail has priority over optional notices. No new delivery loop/transport.

Add one workspace-notice purpose. Preparation locks the person's preference and
records one pending batch and its bounded subject/revision witnesses atomically
with the sealed message. A window reservation prevents duplicate preparation;
only a definitively superseded, never-dispatched message releases its reservation.
Submitted, definitively attempted and possibly delivered outcomes remain covered.
Coverage is per thread, not one global revision: independent commits may arrive
out of sequence. The existing 30-day mail retention outlives a notice's logical
life, so deleting old witnesses cannot resurrect old mail.

Each cycle prepares at most 10 recipients. A batch witnesses at most 100 subjects,
renders at most 25 bounded lines plus an Inbox link/more count, and fits the
existing 12 KiB application-envelope plaintext bound (within the 32 KiB mail
payload schema). Excess work continues in later bounded passes and windows. There is at most one pending batch per person/workspace. Do not allocate
one message per failure, scan an unbounded population or wait for a noisy workflow
to become quiet before sending.

A notice payload contains safe summary snapshots only: existing names, kind,
counts, safe codes and own-origin links. Never include run inputs/outputs, variable
values, provider errors, task instructions/comments, credentials or file data.
No arbitrary recipient, destination URL or sender comes from a personal command.

Before actual dispatch, check the current user, verified recipient email,
workspace, membership incarnation/role, effective preference/default and EVERY
included subject, including mutes and current approval eligibility. If any is no
longer eligible, refuse that old batch before SMTP DATA and rebuild only eligible
content on a later pass. SMTP reports a refused callback as retryable today: the
handler must distinguish policy refusal and settle it as safely superseded. Keep
possible SMTP delivery outcomes in reconciliation; never automatically repeat
one. Dispatch authorization linearizes at that short check; a later revocation
cannot unsend a message already dispatched.

Persist the next hourly/daily scheduling time; compute it in TypeScript when
preferences/defaults change or a due window is checked. Use Intl and a bounded
local-calendar calculation, including half-hour DST transitions; no host timezone
or minute-by-minute polling of every recipient. Missed windows coalesce once.
Pure schedule functions accept the observed time as a domain input, not a
production test clock hook.

### Unsubscribe capability

Use the existing versioned application envelope, with purpose-specific AAD, for a
bounded capability containing person, workspace, personal preference revision,
membership incarnation and expiry (90 days). Keep it in the URL fragment and a
redacted request header, never query/log/referrer/query-cache data. GET opens a
plain confirmation; POST changes only that person's email override to Off. Exact
retry can confirm already Off; an old link cannot undo a later opt-in or a new
membership. Wrong purpose, stale/expired capability or retired key gives a safe
unavailable message and normal sign-in/Settings recovery. No new key or token
history table. Email action links lead to normal authenticated screens.

## Ownership and delivery

1. Commit this current-code plan and ADR/amendments first. No owner review pause.
2. Mechanical moves only: system-mail source ownership and any necessary inbox
   file grouping; extract the unchanged Date IANA schema to a browser-safe shared
   model value schema for its second consumer. Preserve node fingerprints,
   queued mail, old imports/exports as needed and auth provider behavior.
3. One additive migration and corresponding Drizzle metadata; generalized
   threads/read migration, precise RLS, preferences/subscriptions/batch witnesses,
   queue purpose, lifecycle/purge and readiness. Never re-squash old migrations.
4. Database `inbox/` owns observations, eligibility, preferences and mail
   preparation behind small interfaces; the platform mail owner owns delivery.
   Keep area folders around ten files, grouping preferences/observations/mail.
5. API `notifications/` owns contracts, guards, commands, public unsubscribe and
   composition with existing identity/mail configuration. Split files by role.
6. Web `features/inbox/` owns Settings, subject actions, kind filters and typed
   rows; routes compose it. Workflow consumers use focused public interfaces.
   Reuse WorkspaceApiScope, retained commands, Query and existing Weft pieces.
7. One F27 PR, Moved/Removed/Lines, required local checks, green CI, rebase merge
   and natural-main/ARM inspection. Moves stay separate from logic commits.

## Verification

- Migrate populated F03 failures/private reads; preserve failure lanes/read cuts.
  Full audience, follow-no-extra-permission, private mute and cross-workspace
  matrices. Removal/rejoin, suspension, user/workspace state and role loss.
- Real authoritative pause/health/capacity/task observations: bounded scan,
  duplicate/restart/multiple workers, resolution and a later new episode. No
  canceled/handled-failure notices, normal active-slot occupancy or arbitrary HTTP
  failure health inference. Task deciders share the actual existing rule.
- Immediate/hourly/daily, UTC/IANA, spring gap, repeated/half-hour DST and worker
  outage. Bounded large/no-match populations, late commits in different threads,
  one pending batch/window, exact retry and stale lease settlement.
- Owned loopback SMTP with exact messages: change role/mute/preferences just
  before DATA, recipient change, connection loss after dispatch, no unsafe repeat.
  Actual database/worker preparation and independent SQL assertions; no provider
  account, paid API or production hook. Existing auth/invitation mail still works.
- Public unsubscribe: wrong purpose/key/expiry/revision/incarnation, idempotent
  retry, later opt-in protected, scanner GET inert, header/token redaction.
- Real API/worker/browser/mail journey; Settings save/conflict/uncertainty, lazy
  follow/mute actions, notice filtering and one approval card. Desktop/phone,
  keyboard and reduced motion; inspect synthetic screenshots. Mocked e2e,
  changed React Doctor, lint/types/units/build/contracts/schema/architecture/Knip.

## Tracker

- [x] Reconciled current code and recorded recommended decisions.
- [x] ADR, contracts and rollout complete.
- [x] Mechanical ownership moves gated separately.
- [x] Persistence, observation, delivery and lifecycle implemented.
- [x] Settings, subscriptions, notice rows and unsubscribe implemented.
- [x] Independent integrated evidence and required checks passed.
- [x] Guide, roadmap and limitations truthful.
Release requires green PR checks, a rebase merge and inspection of natural-main
CI/ARM publication. The PR is the source of current merge/publication receipts;
the code tracker above records implementation and local qualification.

## Rollout and later work

Deploy matching schema/API/worker readers together before enabling new notice
writers or email preferences. Defaults are Off. Retain compatible readers after
new kinds/purposes exist; do not downgrade a worker that cannot read queued mail.
Turning personal email Off prevents new preparation and invalidates queued notice
content at dispatch. Do not remove unread notices or shared workflow alerts.

No mobile push, new chat transport, public approval action, incident management,
per-app email frequency, marketing mail, tracking pixels or environment-specific
preferences. Notification delivery is best effort; the Inbox/task remains the
source of attention when mail is rejected or needs reconciliation.

## Implementation refinements — 2026-10-15

- The shared application envelope accepts 12 KiB plaintext. Keep that tighter
  existing bound: at most 25 lines, names capped at 64 Unicode code points, at
  most 100 revision witnesses, and a bounded Inbox/more link. No format or crypto
  limit expansion.
- Open personal follow/mute choices from workflow Settings and connection detail.
  The query exists only while its sheet is open. This reuses current detail
  ownership without adding list-row requests; focused public entries preserve
  lazy page boundaries.
- Maintenance discovery reads only workspace/membership IDs and scheduling state.
  User status and verified recipient email are checked with scoped app authority,
  retaining the existing maintenance role's lack of user-table access. Current
  source/audience predicates filter before the 100-item limit, so irrelevant
  subjects cannot starve a followed workflow.
- Optional notice preparation runs when the shared mail queue has no claimable
  message, preserving queued security-mail priority and availability if preparation
  fails. A scoped source check still immediately precedes dispatch.
- Public unsubscribe uses a dedicated existing-rate-limiter policy: fail closed,
  30 requests/minute/client address, no Form identifier or shared Form allowance.
- The removal boundary invokes a narrow database cleanup fence only after the
  membership has become removed in that same transaction. This permits private
  state cleanup without allowing another member to select private choices.
- New thread IDs use PostgreSQL 18's native UUIDv7 inside the existing SQL fold
  and migration; the application observer uses the existing persisted-ID owner.
  Read cuts, timestamps and old failure aggregation survive the additive upgrade.

Evidence is recorded after the corresponding checks pass; unfinished tracker
items remain open. The personal notification guide is [notifications.md](../notifications.md).


## Local qualification receipts — 2026-10-15

- Populated additive upgrade, existing Inbox behavior, preferences/audiences,
  observations and batch tests pass through PostgreSQL 18 with the actual app
  and maintenance roles. Persisted hourly/daily boundaries survive worker restart;
  downtime produces one current batch. A 101-subject workload produces 100
  witnesses followed by the remaining subject in a later window. A queued-mail
  purge removes its sealed delivery and private state before membership removal.
- Actual worker/SMTP qualification covers security mail and personal notice mail,
  safe content, authorization revoked before DATA, post-DATA acknowledgement loss
  and recovered uncertain leases without repeating delivery. The maximum Unicode
  notice body fits the existing 12 KiB plaintext envelope.
- The real API/worker/browser/SMTP journey exercises exact retry after a committed
  save loses its response, daily/immediate choices, a failed run, private follow
  and mute, scanner-inert unsubscribe and an explicit anonymous confirmation.
  Independent SQL checks verify receipts, revisions, coverage and run state.
  The existing named-decider Approval browser journey also passes with one notice.
- Inspected synthetic screenshots at desktop and phone widths with reduced motion:
  [settings](../media/notifications/settings-desktop.png),
  [phone settings](../media/notifications/settings-phone.png), and
  [Inbox](../media/notifications/inbox-desktop.png). React Doctor: 100/100,
  no suppressions. Unsubscribe invalidates schedules already cached in its tab.
- Single-server configuration/credential isolation passes for KMS/self-managed
  encryption and SMTP/Resend. Storage preparation and restore verification use
  the shared system-mail configuration owner too.

Local gates: 9,184 Vitest unit tests plus native runtime checks, 176 mocked
browser cases (including Firefox/WebKit smoke), full build/lint/strict types,
format, Knip, contracts, schema ownership and boundaries. Single-server tests:
42/42. PostgreSQL: all 32 Inbox cases plus the added queued-mail purge case,
40 lifecycle/task-retention cases (the broad purge test also passed in isolation),
and the existing real Inbox API cases. Real SMTP: 3/3. Both owned notification
and named-decider Approval browser journeys passed.

The PR records CI receipts. GitHub's PR checks and
natural-main image publication are the rollout authority; local qualification
alone is not a deployment receipt.
