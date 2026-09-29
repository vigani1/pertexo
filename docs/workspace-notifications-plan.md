# Workspace inbox notifications and live updates

Status: in progress under accepted
[ADR055](adr/055-workspace-inbox-failure-threads.md), which supersedes
[ADR054](adr/054-durable-workspace-inbox.md)'s per-recipient delivery model.
Created 2026-09-25; redesigned 2026-09-29. Delivery is tracked in
[F03](feature-plans/03-workspace-notifications.md).

## 1. Outcome and scope

Give owners, admins and operators a durable inbox of failing workflows in the
active workspace, updated while the app is open and recoverable after
disconnects. Preserve the existing architecture: PostgreSQL authority, NestJS
feature modules, browser-safe contracts and React feature ownership.

Three concepts stay distinct:

- Run events and live run status: existing execution truth and run SSE.
- External failure alerts: ADR 022 intents, delivery and destinations,
  configured on the Alerts page.
- Workspace inbox notice: a shared thread per failing workflow with each
  person's private read state. Reading is not acknowledging or resolving.

First slice: terminal `failed`, `timed_out` and `outcome_unknown` runs. No
success, cancellation, step, retry, queue-progress or connection-health notices,
and no backfill. A replay is a new run and counts as a new failure.

Deferred: invitations, account-security notices, per-person muting,
subscriptions for builders, digests, mark-unread, dismissal, push, email and a
cross-workspace inbox. No new package, WebSockets or generic event bus.

## 2. Model

A **thread** exists per workspace and workflow once that workflow fails. It
holds the failure count, first and latest failure time, latest run and kind,
and a revision from one database sequence. A new failure raises the revision,
which makes the thread unread for everyone. After 30 days without failures the
thread expires; a later failure starts a new count.

A person's state is one **read** row per thread they have read, holding the
revision they read. Unread means no read row or an older revision.

## 3. Write path

1. The coordinator's terminal transition inserts one `workspace_inbox_events`
   row (workspace, workflow, run, terminal event sequence, kind, time) in the
   same transaction, only while the worker's `WORKSPACE_INBOX_PRODUCER` flag is
   on. The insert is unique per run and terminal sequence and touches no shared
   row, so a burst of failures never contends.
2. A worker loop calls `app.fold_workspace_inbox_events(limit)` every few
   seconds. It takes pending events with `FOR UPDATE SKIP LOCKED`, upserts each
   affected thread once in key order, deletes the events and returns the new
   revision per workspace, all in one transaction. Several workers can run it.
3. Events of a workspace being deleted are consumed without creating threads.
   A pending event is deleted with its run.
4. After a fold commits, the worker publishes a content-free hint on the
   workspace's Redis channel.

The fold and expiry commands are owner-run, executable only by the worker, and
pinned by startup readiness (see
[database function readiness](operations/database-function-readiness.md)).

## 4. Authorization

- Eligibility is `app.workspace_inbox_recipient_eligible`: active workspace,
  active user, active owner/admin/operator membership, and the actor is the
  session user. RLS applies it to every thread read and every read-row change.
- The shared role policy grants the same roles `notification:read`, which the
  API requires and the web uses to show the Inbox destination.
- The API role can select threads and insert or raise its own read rows; it
  cannot write threads or events. The worker can only insert events for its
  tenant context.
- Other workspaces' or ineligible readers' requests see nothing; the API maps
  that to the established non-disclosing responses.

## 5. HTTP contract

Under `/v1/workspaces/:workspaceId/notifications`:

| Method/path | Behavior |
| --- | --- |
| `GET /` | Threads by latest failure, newest first; `filter=all\|unread`, `limit` 1–100 (default 25), opaque keyset cursor bound to workspace and filter; returns items, next cursor and observed revision |
| `GET /summary` | Unread thread count and observed revision |
| `POST /:workflowId/read` | `{ revision }`; records `min(revision, thread revision)`, never lowers; returns unread state and thread revision; 404 if not visible |
| `POST /read-all` | `{ revision }`; marks visible threads with revision ≤ the given one; later failures stay unread |
| `GET /events` | SSE: `ready` on connect, then `inbox.changed` hints with the revision only |

Each item carries the workflow ID and name, kind, occurrence count, first and
latest failure time, latest run ID, latest failed step when known, revision and
unread flag. No run input or output, provider error text, credentials or
arbitrary URLs. Mutations use cookie sessions, CSRF, request IDs, rate limits
and the problem format; reading a list never marks anything read.

## 6. Live transport

SSE is a hint channel; PostgreSQL remains truth. The API subscribes to the
workspace's Redis hint channel, shares one subscription per workspace per
process, and rechecks the session and eligibility under ADR 004's watchdog
rules, closing the stream on revocation. Heartbeats, bounded buffers, per-user
and process connection caps, and cleanup on close and drain follow the run
stream's existing infrastructure. Browsers refetch the summary and list on each
hint, on focus and on reconnect, so a missed hint loses nothing.

## 7. Frontend

`apps/web/src/features/inbox/` owns the API, queries, mutations, stream hook,
presentation model and the inbox page. The workspace spine and phone bar show
an Inbox destination with the unread count to people who hold
`notification:read`. TanStack Query owns threads and counts, keyed by account,
workspace and filter; one stream per active workspace per tab invalidates
them, coalesced. Mutations are pessimistic and then invalidate. Visiting the
inbox does not mark anything read; opening a thread marks it read and
navigates to its latest run, with a link to the workflow's run history. Loading, empty, error, stale and forbidden states are
distinct; keyboard, focus return, reduced motion and 390px widths are required.

## 8. Retention and deletion

A worker loop calls `app.expire_workspace_inbox_threads(limit)` to delete
threads, with their reads, 30 days after their latest failure, skipping
workspaces under an active legal hold. Workspace purge deletes reads, threads
and events before workflows, runs and memberships.

## 9. Verification

- Real PostgreSQL: producer dedupe and cancellation, worker-only inserts,
  concurrent folds, visibility and eligibility, unread and stale revisions,
  read-all cut, paging, window, expiry and hold, purge.
- Worker: loop cadence, readiness failure, shutdown drain, flag off.
- API: authorization and cross-tenant denial, contract validation, cursor
  tampering, SSE authorization on connect and mid-stream, two API processes.
- Frontend: component tests for states and actions; browser tests at desktop
  and 390px against the local stack, triggered by an actual failing run.
- Regressions: run SSE, external failure alerts, run execution and workspace
  deletion unchanged.

## 10. Rollout

Migrate first; deploy API and worker readers; enable the producer flag once
the worker's fold readiness passes. Only new failures appear. Turning the flag
off stops new events; existing threads expire. No production rollout, external
mail or paid providers are authorized by this plan.

## History

ADR054's foundation (PR115), audience capture (PR116) and fan-out (PR117)
merged inactive and were never activated. Migration 0123 removes their tables
and commands, refusing to run if any hold rows.
