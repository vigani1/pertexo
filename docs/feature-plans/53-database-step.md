# F53 — Database step (PostgreSQL)

Status: in progress. First slice of [F21b](21b-next-integrations.md).

## Outcome

Create a PostgreSQL connection in the workspace, test it, and select it on a
Database step. Choose Run query, Insert rows, Update rows or Upsert rows in
the editor. Downstream steps can map the returned rows as items or use the
row count. Map query values as an ordered Parameters array and writes as a
Rows array keyed by column name. An update row includes the configured key.
The entire write batch commits or rolls back together.

Custom query and row operations follow the PostgreSQL integrations in
[n8n](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.postgres),
[Zapier](https://zapier.com/apps/postgresql/integrations) and
[Make](https://www.make.com/en/integrations/postgres).

## Decisions

- Store host, port, database, user, password, TLS mode, optional CA and
  read-only preference in the existing encrypted connection flow. Test with
  `SELECT 1`. Require TLS by default, offer certificate and hostname
  verification, and allow disabling TLS only for explicitly allowed private
  destinations.
- Resolve and pin the destination through the SMTP and HTTP address policy.
  The same private-network allowlist applies, including to Pertexo's own
  database. Cloud metadata addresses are always denied.
- Bind mapped values to PostgreSQL parameters. For row operations, validate
  schema, table and columns against PostgreSQL and quote identifiers. Update
  matches a key column and upsert uses the selected conflict columns. Run
  read-only queries inside a read-only transaction.
- Open one connection per attempt so each attempt checks the destination and
  releases its socket and session state when it finishes. Bound statement
  time and the number and encoded size of returned rows. Return specific
  safe failures and retry transient connection, timeout and serialization
  failures. Treat a lost commit acknowledgement as an unknown outcome.
  Keep credentials out of logs and run data.

## What changes

Contracts and connection settings gain PostgreSQL. Secrets owns the secure
client using the existing `pg` driver. Integrations owns the Database
operations and the catalog schema that draws their editor fields. The API
and worker supply the secure client.

## Tests that prove it

- Run against a separate test database and role. Check parameter binding,
  read-only transactions, quoted identifiers, each write operation, all
  limits and safe failure codes.
- Verify the address policy rejects blocked private and metadata targets and
  that connecting uses the checked address. Check failed run data and logs
  for credential redaction.
- Create a connection and run a Database query in the editor, then inspect
  the returned rows.
