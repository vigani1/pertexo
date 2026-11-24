# F55 — Database row trigger (PostgreSQL)

Delivered. Parent: [F21b](21b-next-integrations.md).
Decision: [ADR 093](../adr/093-polling-triggers.md).

## What the builder does

Add a **Database Row** trigger, select a PostgreSQL connection, and configure
the schema, table, ordering column, key column, poll interval and mode.
Use a stable, unique, non-null key and an increasing ordering value such as
a serial ID or an `updated_at` timestamp. In **New and updated rows** mode,
the ordering value must advance on each update. **New rows only** uses the
row's key alone. The first successful check establishes a baseline. Later
checks start a run for each unseen row or revision, available as `item`.

The event choices follow [n8n's Postgres Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.postgrestrigger)
and [Make's Watch Rows](https://apps.make.com/utilize). The table, key and
ordering settings follow [Zapier's PostgreSQL triggers](https://zapier.com/apps/postgresql/integrations).

## Implementation

- **Secrets and integrations.** Read the newest rows in a read-only
  transaction through the Database step's secure PostgreSQL client. Check
  identifiers against PostgreSQL and quote them. Require a unique key backed
  by a database index. Order by the ordering column descending, break ties by
  key, and bind the scanner's `POLL_MAX_ITEMS` limit. Reuse address policy,
  TLS, statement and result limits, and safe PostgreSQL failure codes.
- **Workflow model, integrations and catalog.** Register `database.poll@1`
  with the existing polling interval bounds, a required `postgres`
  connection, the setup schema and the polling output executor.
- **Worker and core.** Resolve credentials through the shared provider
  connection runtime. Key each item by the row's key or the pair of key and
  ordering value. Use the existing scanner, seen-set and run admission to
  baseline once per publication and admit unseen rows oldest first. Reuse
  polling health, immediate pause on confirmed authentication loss and
  resume on the same publication. This uses the existing poll table and ADR.
- **Contracts and web.** Expose the new trigger through the existing
  published-trigger and pause contracts. Reuse the polling card and explain
  that changes beyond the fetched head, or intermediate revisions between
  checks, can be missed.

## Tests that prove it

- Against a separate PostgreSQL test database, baseline existing rows, then
  insert rows and verify one run per key, oldest first. Update a row and
  verify that only the update-aware mode starts another run.
- Exercise quoted identifiers, a read-only transaction, the address policy,
  authentication pause, item and result limits, and safe rejection of a
  non-unique key.
- Reuse the HTTP polling editor journey where practical to publish, insert a
  row and inspect the next step's input.
