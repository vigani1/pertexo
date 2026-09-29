# F03 — Durable in-app notifications and live inbox

Status: in progress — redesigned under accepted
[ADR055](../adr/055-workspace-inbox-failure-threads.md); database and worker
layers merged. API and frontend slices open.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: New frontend + backend product. Relative size: **L**, not a calendar estimate.

## Outcome

An owner, admin or operator sees one notice per failing workflow in the active
workspace, with how often and how recently it failed, correct private unread
state, live updates while the app is open and recovery after reconnecting.

## Design

[ADR055](../adr/055-workspace-inbox-failure-threads.md) replaces ADR054's
per-recipient delivery with per-workflow threads computed on read. Cost grows
with failing workflows, not failures × people:

- A terminal `failed`, `timed_out` or `outcome_unknown` run inserts one event
  in its own transaction, behind the worker flag `WORKSPACE_INBOX_PRODUCER`
  (default off). Cancellation, success and history before activation produce
  nothing.
- A worker loop folds pending events into threads in bounded,
  `SKIP LOCKED` batches and deletes them in the same transaction, so each
  failure counts exactly once.
- A thread is unread for a person until they read its current revision. Single
  read never exceeds the thread's revision or moves backwards; read-all marks
  threads at or below the revision the person saw, in one statement.
- Row-level security limits threads to eligible readers of an active
  workspace; threads are visible for 30 days after their latest failure.
- The worker publishes a content-free per-workspace hint after each fold; the
  API streams it over SSE and browsers refetch.

ADR054's product rules (audience, sources, no backfill, reading is not
acknowledgement, external alerts stay independent) remain.

## Ownership and structure

| Owner | Responsibility |
| --- | --- |
| `packages/database` | Migration 0123, event producer in the terminal transition, fold/expiry commands and readiness, recipient read store |
| `apps/worker` | Producer flag, fold/expiry loop, readiness and shutdown, change hints |
| `packages/queue` | Bounded per-workspace inbox hint channel |
| `packages/contracts` | Thread list, summary, read, read-all and stream schemas; `notification:read` capability |
| `apps/api/src/notifications/` | Thin controllers, authorization, use cases, SSE lifecycle |
| `apps/web/src/features/notifications/` | Bell, inbox, read actions, deep links, live refresh |

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).

## HTTP contract

Under `/v1/workspaces/:workspaceId/notifications`, requiring
`notification:read`:

| Method/path | Behavior |
| --- | --- |
| `GET /` | Threads newest first; `filter=all\|unread`, `limit` ≤ 100, opaque keyset cursor; returns the observed revision |
| `GET /summary` | Unread thread count and observed revision |
| `POST /:workflowId/read` | `{ revision }`; records at most the thread's current revision; repeat-safe |
| `POST /read-all` | `{ revision }`; marks threads at or below the observed revision |
| `GET /events` | SSE hints for this workspace; reauthorized under ADR004's session rules |

## Delivery slices

1. **Database (PR A):** migration 0123 retires ADR054's unactivated tables and
   commands (refusing to run if any hold rows) and adds events, threads and
   reads with RLS; producer wiring behind the store option; fold/expiry
   commands with startup readiness; recipient read store; purge participation.
2. **Worker (PR B1):** `WORKSPACE_INBOX_PRODUCER` flag, fold/expiry loop with
   startup compatibility, readiness and shutdown, and per-workspace Redis
   hints.
3. **API (PR B2):** `notification:read`, thread contracts and HTTP/SSE
   endpoints with real-database API tests.
4. **Frontend (PR C):** bell with unread badge, inbox panel, mark read and
   read-all, deep links to the latest run and the workflow's failed runs, live
   refresh via SSE plus refetch on focus and reconnect; component and browser
   tests against the local stack.

Each slice ends in tested behavior; no enabled control is backed by an absent
endpoint.

## Acceptance evidence

Cross-tenant and ineligible-reader denial, membership or role loss, concurrent
folds never double counting, read-all versus new failure, stale read revision,
30-day window and expiry under legal hold, workspace purge, missed hint
recovery, two tabs, and an actual local run failure reaching the inbox.

## Non-goals

Push or mobile delivery; success or step notices; incident acknowledgement.
Per-person muting, builder subscriptions, email or digest delivery and more
notice types are planned in [F27](27-notification-preferences-and-channels.md);
pausing workflows that keep failing is [F26](26-workflow-auto-pause.md). Both
extend the same thread model.

## Rollout and rollback

Deploy the migration and readers first; the producer flag stays off until the
worker's fold readiness passes. Turning the flag off stops new events; existing
threads age out. Rollback never drops populated tables. No production rollout,
paid provisioning or external calls are authorized by this plan.

## Delivery tracker

- [x] ADR054 foundation, capture and fan-out increments merged inactive (PR115–PR117).
- [x] Redesign accepted as ADR055 before any activation.
- [x] Database layer (PR A, PR118) merged with green checks.
- [x] Worker (PR B1, PR119) merged with green checks.
- [ ] API (PR B2) merged with green checks.
- [ ] Frontend (PR C) merged with green checks.
- [ ] Real integrated acceptance evidence recorded.

### Database layer evidence (2026-09-29, PR A)

Real PostgreSQL: `workspace-inbox-threads.integration.test.ts` passes 14 cases
covering producer dedupe and cancellation, worker-only tenant-scoped inserts,
fold counts and latest failure, concurrent folds (90 failures, four parallel
folders, exact counts), 30-day restart, purging-workspace consumption,
owner/admin/operator visibility and builder/viewer/suspended/cross-tenant
denial, the visibility window, unread and stale-revision semantics, read
privacy, the read-all cut, keyset paging, monotonic reads, expiry with legal
hold and release, and child-first workspace purge. The coordinator suite proves
the producer writes nothing when off and exactly one event per terminal failure
when on, including redelivery.

### Worker evidence (2026-09-29, PR B1)

The worker reads `WORKSPACE_INBOX_PRODUCER` (default `false`) into the
coordinator's run store, and runs the fold/expiry loop on every worker. The
loop checks the reviewed commands once before running any, folds bursts back
to back, sweeps expiry on its own interval, and reports readiness from its
latest cycle. A failed hint is logged and never fails a cycle. Unit tests
cover these paths plus shutdown during a fold. A real PostgreSQL and Redis
test proves a pending failure becomes a thread, is consumed, and publishes one
content-free hint carrying the thread's revision. The run-event publisher now
shares the same bounded Redis publisher.
