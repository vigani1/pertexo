# F19 — Comments and editing presence

Status: implemented; comments, mentions and advisory presence qualified. Updated: 2026-10-18.
Parent: [roadmap](../product-roadmap.md). Authority: the owner's comments/presence
scope; recommended choices below are selected without another approval gate.

## Outcome and current owners

Members discuss a workflow or a particular step, notify named colleagues and see
who else is viewing or editing. Draft saves keep their existing optimistic
concurrency. Multiplayer remains later work with its own protocol decision/ADR.

Main `329c5f0c8` includes F18 governance, F28 identity/provisioning and F17 promotion
(#348). There is no existing comment or presence store. Reuse:

- `database/authoring/workflows`: scoped, tracked transactions and workflow authority.
- `workflow-model/graph`: globally unique step IDs, including nested loop bodies.
- `database/inbox/eligibility.ts`: the single notice-audience owner; F27 observation,
  private read state, mute/follow, email schedule, final authorization and SSE hints.
- `database/lifecycle`: explicit bounded purge steps and the existing retention loop.
- `web/routes/workflow/hub`: one authenticated workflow lifetime, editor store and
  serialized save coordinator; draft ETags/revisions remain authoritative (ADR 011).

[ADR 055](../adr/055-workspace-inbox-failure-threads.md) and
[ADR 079](../adr/079-personal-notices-and-mail.md) retain their delivery
rules. Ordinary comments and expiring advisory presence do not introduce a new
collaborative editing protocol or require a new ADR.

## Decisions and rules

### Comments and access

- A comment thread belongs to one workflow, optionally anchored to a stable step
  ID. IDs are unique across nested bodies; use that existing identity, never a
  step name, array position or a new graph field. Starting a step thread requires
  exactly one current draft match. Renaming preserves it; removing a step keeps
  its discussion, labelled with its former name and a missing-step explanation.
- Any member who can currently read the workflow can create/reply and resolve or
  reopen a thread. Only the author can edit/delete their own comments. Archived
  workflows keep the same discussion read permission. No folder ACL or new role.
- Use plain text, at most 8,000 characters, validated with the existing storage-
  text rule (valid Unicode, no NUL). No raw HTML, attachments or rich-text parser.
  Reads are paged, at most twenty comments per page, without loading all history.
  No speculative permanent thread-count quota: comments remain until deleted.
- Comments have independent revision checks; resolving/reopening checks the thread
  revision. A reply to a resolved thread asks the member to reopen it. Stale edits
  preserve local text and require review; no silent last-write-wins.
- Keep the thread separate from its comments. Deleting an author's opening comment
  preserves other people's replies. Remove an empty thread after its last comment
  is deleted. Delete the canonical text, rather than keeping a hidden body/history.
- Reuse command receipts for create/reply/edit/delete/status with compact IDs and
  revisions only. Request hashes may identify a retry; receipts, audits and mail
  never copy comment text. Exact uncertain retries cannot create duplicate replies
  or notices. Existing current-access checks also apply to replayed commands.
- Metadata audit facts record the actor, workflow/thread/comment and operation;
  no bodies. Discussion follows workflow/workspace deletion, with explicit bounded
  purge steps even where FKs also cascade. Run retention does not delete comments.
  Export/import, duplication and promotion never transfer discussions or presence.

### Mentions and notifications

- A composer has an explicit **@ Mention** member picker and visible selected
  people. Reuse the existing task audience’s names-only discovery through a shared
  member directory query and a discussion read fence. Keep the admin Team roster’s
  email visibility and task-audience edit fence unchanged. This is not a username
  grammar. Mention chips remain visible alongside the plain text. At most twenty
  distinct current eligible members; self-mentions do not create a notice.
- A mention identifies its comment and recipient. Validate current membership and
  workflow read access when saving; notification visibility and delivery recheck
  current access through the single TypeScript audience owner.
- Add `workflow_mention` to the existing notice kinds. One explicit mention is an
  attention subject; do not build another recipient queue or change failure
  aggregation. The existing attention observer creates its inbox notice and sends
  existing content-free hints. F27 schedules and workflow mute choices apply.
- Only newly added mentions notify. Editing text or retaining the same recipients,
  resolving/reopening, or retrying a committed command does not notify again.
  Removing a mention/comment removes its notice; re-adding is a new explicit mention.
- Inbox and email identify the workflow and link to the discussion/comment, without
  copying the body. Keep F27's thirty-day notification window; an old stored
  comment must not cause its notification to be recreated after retention.
  Retention expires mentions even if observation was offline at the cutoff.
  Discussion itself remains available until deletion.

### Presence and draft safety

- Presence is metadata about an authenticated tab, not an edit lease or permission.
  Store no graph, cursor, selection, field value or unfinished text. Report viewing,
  editing and whether there are unsaved changes, plus the editor's base revision.
  Claiming editing requires current workflow edit access; readers report viewing.
- Use short PostgreSQL-backed leases so several API instances agree. No WebSocket,
  new Redis protocol, process-wide user map, service, worker or infrastructure.
  A visible tab heartbeats every fifteen seconds, immediately reports a change in
  editing/dirty state, and expires after forty-five seconds without a heartbeat.
  Queries refresh every ten seconds while visible and on focus/reconnect.
- Give each tab its own opaque ID and monotonic heartbeat sequence. A late old
  heartbeat cannot clear a newer dirty state. Aggregate people across tabs, retaining
  unsaved indicators from any tab; warn about one's own other editing tab too.
  Bound leases to one hundred per workflow and ten per member/workflow, under a
  short workflow lock. Refusing presence never blocks editing or execution.
- Closing a hub stops renewals and aborts its outstanding requests; lease expiry
  handles disconnects. Do not issue an unordered unload DELETE that could erase
  a newer heartbeat during a tab/remount race. Leaving Build reports viewing.
- Expiry is checked on every read. The existing retention loop removes expired
  rows in bounded pages, repeating the condition when deleting; workspace/workflow
  deletion also removes them. Membership removal hides presence immediately.
  Every read/write releases its connection before responding or waiting on a client.
- The workflow hub owns the tab lifetime. The editor reports only its current
  editing/dirty/revision projection. Presence UI shows names and viewing/editing
  state, with a visible unsaved-changes warning before conflicting saves. It never
  merges or locks edits, force-saves, replaces local scratch, or bypasses ETags/CAS.
  Offline/background expiry is advisory; the existing conflict check remains final.

## Structure and delivery

One feature PR with coherent, buildable commits; moves precede logic separately.

1. Update this plan, glossary and roadmap after F17's green merge. Review the
   interface against current authoring, notice, editor and lifecycle owners.
2. If needed, extract the existing nested-node iterator from graph identity as a
   move-only commit, then expose/reuse the pure owner. Do not add another traversal
   helper, package entry point or node-address format.
3. Add typed tables under `schema/authoring/collaboration/`: comment threads,
   comments, explicit mentions and tab presence. Generate migration 0036, with the
   existing three-role grants and forced workspace RLS. Extend inbox subject FKs,
   structural checks, schema inventory, readiness and legacy-upgrade fixtures.
4. `database/authoring/collaboration/` owns authority, threaded commands/reads and
   presence through the existing authoring transaction/lifecycle. No independent
   pool or generic collaboration framework. Add notice source/audience integration
   to their existing owners; add explicit purge and presence retention rules.
5. Contracts own strict browser-safe DTOs and OpenAPI. API
   `workflow-authoring/collaboration/` owns session/CSRF, existing rate limits and
   safe errors under `/workflows/:workflowId/comments` and `/presence`. Initial
   collaboration is member-session only; no automation-token scope expansion.
6. Web `features/workflow-collaboration/` owns queries, retained commands, comments,
   member selection and scoped presence. Routes compose a Comments view in the
   workflow hub; step discussion actions carry the existing step ID. Keep forms
   plain, paged history, keyboard access and phone navigation at a fixed header
   height. The hub owns presence, while the editor remains the only draft owner.
   Keep query updates and open menus stable; no revision keys that remount forms.
   The editor owns the publication feedback layer below its bar and notices;
   publishing supplies content through that composition slot. Feedback must not
   cover wrapped header controls or sit behind the phone inspector.
7. Qualify through actual app-role PostgreSQL, HTTP and two browser sessions;
   document `docs/guides/collaboration.md`, update trackers, normal hooks, exact-head
   green CI and rebase merge. Reuse the existing live-browser job with an owned
   collaboration scenario; no new CI job.

## Acceptance and rollout

- Current permissions, cross-workspace denial, member removal/SSO deprovisioning,
  own-only edits/deletes, revision races, lost-response replay, Unicode/body bounds,
  deleted steps, resolved replies and preserving other replies after root deletion.
- Mentions: current recipients only, no self/duplicate/retry/edit spam; removal,
  mute, immediate/digest email audience, expiry without re-alert, safe links and
  metadata-only audit/mail/receipts. Verify actual inbox observation/visibility.
- Presence: two people/multiple tabs, out-of-order heartbeats, expiry/reconnect,
  role loss, bounds, cleanup and short pool checkouts. Measure the bounded maximum.
  Existing stale-save race proves one winner and preserved local changes.
- Real browser desktop/375px: create workflow/step threads, mention, inbox link,
  resolve/reopen, edit/delete, two viewers/editors and an unsaved-change warning.
  Build, lint, types, units, mocked e2e and React Doctor without suppressions.
  Assert an open menu and a typed comment survive background refreshes.
- Additive schema rollout with updated readers/API before the updated notice
  observer. Stop old readers before migration as the existing inbox rollout
  requires. Rollback stops new writers/observers; retain comment rows, never reset
  or erase user discussions. No Docker download, paid service or external account.

## Local evidence (2026-10-18)

Actual app-role PostgreSQL proves author-only edits, concurrent revision winners,
exact command retries, paged history, explicit bounded purge and current-access
mention visibility. Mention observer/mail tests cover self/mute/removal, unchanged
edits and old-source retention without recreating notices. The real HTTP boundary
qualifies session/CSRF composition, strict requests, replay and stale edits.

At the maximum, one hundred actual tab leases aggregate to one hundred people,
a response of 86,002 bytes and concurrent workflow reads of 9.29–17.40 ms with a
pool of two connections; no idle transaction remains. Out-of-order heartbeats,
ten-tab/member limits, expiry and immediate role/member loss are qualified.
Names are bounded metadata; step labels snapshot at most 256 UTF-16 code units.
Personal email retains its existing 12 KB envelope by displaying fewer digest
items when necessary, with the remainder linked from Inbox.

The editor exposes a metadata-only subscription at its public composition seam.
The hub's presence bridge subscribes directly; there is no React effect copying
live draft state into a parent or second graph store. Background refreshes keep
composers and pickers mounted. Resolving a thread disables, but preserves, an
unfinished reply.

## Later

Live multiplayer/co-editing, CRDT/OT/shared undo, inline canvas annotations/cursors,
attachments/rich text, public discussion links and folder-level permissions. A
multiplayer protocol requires its own plan and ADR; presence is not that protocol.

## Tracker

- [x] Reconciled against main after F17; recommended product/ownership decisions reviewed.
- [x] Storage/contracts/authoring and notice behavior qualified.
- [x] Presence, lifecycle and concurrency bounds qualified.
- [x] Web, real two-session acceptance, guide and required checks qualified.

Release evidence belongs to the feature PR: normal hooks, exact-head green CI,
rebase merge and the natural-main run. No multiplayer protocol is included.
