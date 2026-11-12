# F21b — What comes after OAuth2 and SMTP

Status: proposed order; not implementation-authorized. Finding:
docs-deps-product-04 (batch J7). Parent: [F21](21-integrations-and-polling.md),
whose slice 1 ("rank journeys, choose one provider") this plan answers. Each
slice below still needs its own short plan and the owner's approval.
Integrations keep their place in the [roadmap](../product-roadmap.md): after
single-server reliability qualification. Nothing was built or measured for
this plan.

## Where we are

Delivered: generic OAuth2 connections for HTTP Request (F21 slice 0, awaiting
sandbox proofs), SMTP for the Send email step, header and HMAC connections,
Slack message, HTTP pagination (F32), webhook test events (F35), retries per
step (F33), and durable trigger deduplication, debounce and throttle (ADR 084).
Triggers are still manual, form, schedule, webhook and workflow error.

## Problem in plain words

The first automation a normal user tries is "when a row is added to my sheet,
post to Slack" or "when an email arrives, save it". Pertexo can call almost any
API through HTTP Request and OAuth2, but it can't **notice** a change in another
system unless that system sends a webhook. It also has no first-class database
step. Every competitor does both.

## How the others do it

- **n8n:** Postgres and MySQL nodes, plus polling triggers (Google Sheets "row
  added", Gmail, RSS) built on a shared poll-time cursor. Its integrations page
  lists Google Sheets near the top.
- **Zapier:** almost every trigger is polling. The directory, sorted by
  popularity, opens with Google Sheets, Gmail and Slack.
- **Make:** "watch" modules (polling with a stored position) for Sheets, Gmail
  and databases, plus instant triggers where the app supports webhooks.

The common shape is one polling primitive that many providers reuse, and the
same few providers at the top everywhere.

## Options

| Option | What                                                                                     | Cost                                                                     |
| ------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A      | Breadth first: thin action-only connectors for 10–20 apps.                               | L, and shallow: no triggers, so the first journey above still fails.     |
| B      | **Primitives first, then the top providers on them** (order below).                      | L overall, delivered in usable slices; each later provider is mostly M.  |
| C      | Wait for F40 (community step SDK) and let others write connectors.                       | XL first, and nobody to write them yet.                                  |

## Recommendation: option B, in this order

1. **Database step (PostgreSQL first, then MySQL).** Parameterized query,
   insert/update/upsert, and a read-only mode. It uses a new `postgres`
   connection type behind the existing outbound-network allowlist. This serves
   self-hosters directly and needs no provider sandbox.
2. **One polling trigger primitive.** A durable per-trigger cursor, a lease on
   the existing worker trigger scanner, and event dedupe through ADR 084's key
   windows. The cursor advances only once runs are accepted. The first user is
   **HTTP polling** ("when a new item appears at this URL", with an item-key
   path), which unlocks any JSON API at once.
3. **Database "new or updated row" trigger** on the same primitive (cursor on
   an increasing column).
4. **Google Sheets:** read, append and update rows, plus a "row added" trigger.
   This is the first provider built on OAuth2 + polling.
5. **Gmail and Microsoft 365 mail:** a "new email" trigger and a send action
   through the user's own account.
6. **Slack trigger** through Events API subscriptions (verification and
   renewal), next to the existing Slack action.
7. **Then by request, one at a time:** Notion, Airtable, Google Drive and
   Calendar, Telegram, Discord, HubSpot, Stripe. Choose by what users actually
   ask for, as F21 already says.

Steps 1–3 need no outside account. Steps 4–6 need the owner's provider sandbox
access, as F21's planning gate says.

## What it would change

- `packages/integrations`: Postgres/MySQL adapters, the Google and Microsoft
  operations, and polling fetchers behind one fetch-page interface.
- `packages/core/src/triggers`: a polling trigger kind with cursor state next
  to schedules; acceptance reuses webhook-style admission and ADR 084 dedupe.
- `packages/database`: one cursor table (forward migration). Before code, an
  ADR records the cursor and backfill rules (first poll starts at "now" or
  backfills a bounded number of items).
- `apps/web`: connection forms for the new types. Operation forms come from
  the catalog schema ([step setup from schema](step-setup-from-schema.md)).

## Tests that would prove it

- Database step: parameter binding and injection safety, the read-only mode is
  refused writes, timeout and row limits, secret redaction, against the real
  test Postgres.
- Polling: a crash between fetch and acceptance never loses or duplicates an
  item, a cursor never advances past an unaccepted item, pages are bounded, and
  a trigger pauses on auth loss. All of this runs on the real database and
  queue with a local HTTP stand-in.
- Each provider: the F21 acceptance list (expired token, rate limit, duplicate
  pages, schema drift) against its real sandbox before it is enabled.
