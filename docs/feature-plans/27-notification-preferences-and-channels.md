# F27 — Personal notification preferences and notice kinds

Status: implementation authorized; recommendations below accepted under the
owner's instruction to choose, document and continue without a plan approval.
Updated: 2026-10-15. Parent: [product roadmap](../product-roadmap.md).
Decision: [ADR 079](../adr/079-personal-notices-and-mail.md).

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
  `schema/workspace-inbox.ts`; accepted F03 SQL fold/recipient policies.
- `runs/pending-tasks/queries.ts`: one audience/blocked predicate for tasks.
- `triggers/pause/fold-store.ts`, `connections/health/`, and
  `runs/queries/usage-capacity.ts`: authoritative source facts.
- `database/src/identity/authentication-mail.ts`, worker
  `identity/authentication-mail-{delivery,runtime}.ts`, and integrations
  `system-mail/`: durable encrypted mail and existing SMTP/Resend delivery.
- API `notifications/`; web `features/inbox/`, the workspace Inbox route and
  workflow row/header menus. Extend these; do not introduce a parallel inbox.

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
| Approval waiting | Pending approval task | Current eligible deciders, excluding starter |

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
existing 32 KiB mail envelope. Excess work continues in later bounded passes and
windows. There is at most one pending batch per person/workspace. Do not allocate
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
- [ ] ADR, contracts and rollout complete.
- [ ] Mechanical ownership moves gated separately.
- [ ] Persistence, observation, delivery and lifecycle implemented.
- [ ] Settings, subscriptions, notice rows and unsubscribe implemented.
- [ ] Independent integrated evidence and required checks passed.
- [ ] Guide, roadmap and limitations truthful.
- [ ] PR green and rebase merged; natural main/ARM inspected.

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
