# @pertexo/database

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

PostgreSQL for the whole product: the one table definition (Drizzle schema
and `schema.sql`), the SQL migrations and their runner, the connection pools
and their roles, workspace-scoped transactions with row security, and the few
storage primitives every core area shares (audit facts, the outbox, command
idempotency, persisted ids). Rules live in TypeScript elsewhere; this package
stores, constrains, isolates and locks.

Node only, with four entries ([ADR 091](../../docs/adr/091-core-layer.md)):
`/schema` and `/primitives` for `core` and `secrets` alone, `/platform` for
pools, readiness and startup (the only one applications import), and
`/testing` for fixtures. It depends on `@pertexo/contracts`,
`@pertexo/workflow-model`, `@pertexo/workflow-engine`, `@pertexo/node-sdk`
and `@pertexo/policy` for the shapes it stores.

## Layout

- `src/schema.ts`, `src/primitives.ts`, `src/platform/index.ts`,
  `src/testing.ts`: the entries.
- `src/config.ts`: the database, migration and maintenance environment,
  read once.
- `src/migrate.ts`: the migration process entry (`db:migrate`, and
  `node packages/database/dist/migrate.js` in the compose files).
- `src/migration-history.ts`: reading applied migrations against the files.
- `schema/`: table definitions by area (`runs/`, `authoring/`, `triggers/`,
  `identity/`, …).
- `migrations/`: the migration runner and its error (the SQL files are in
  the package's own `migrations/` folder).
- `platform/`: pools and their policy (`pool/`), command idempotency
  (`idempotency/`), readiness, persisted ids and primitives, query errors and
  the workspace database factory.
- `tenant-access/`: workspace-scoped transactions (`transactions/`) and the
  app settings they set.
- `governance/audit/`, `outbox/`: audit facts and outbox events.
- `testing/`: disposable databases and Postgres fault proxies for tests.

## Where new code goes

- A new table: its definition in `schema/<area>/`, exported from
  `schema.ts`, a migration in `migrations/` and `schema.sql` regenerated;
  `pnpm database:schema:check` compares them.
- A new shared primitive: only when two or more core areas need the same
  storage rule; export it from `primitives.ts`.
- A new pool or role setting: `platform/pool/policy.ts`.

## Defaults and config

- Environment: `config.ts` (`parseDatabaseConfig`, `parseMigrationConfig`,
  `parseMaintenanceDatabaseConfig`, `parseOperatorDatabaseConfig`), with the
  timeout bounds beside them.
- Pool sizes and timeouts per role: `platform/pool/policy.ts`; the expected
  migration head and minimum PostgreSQL: `platform/readiness.repository.ts`.

## Rules

- Applications import only `/platform`, plus `/testing` from tests (a check
  enforces it).
- Every workspace query runs in a transaction that set its tenant context;
  `tenant-access/transactions/scope.ts` verifies the context before and after.
- Transaction-local settings only: the check refuses session `set` outside
  the migration runner's marked statements.

## Exceptions

- Two named files sit at the `src` root beside the entries and config:
  `migrate.ts`, because compose and `db:migrate` run it from `dist`, and
  `migration-history.ts`, because the single-server deploy mounts its `dist`
  file alone. For the same reason `migration-history.ts` keeps
  `PartialMigrationHistoryError` and imports no relative file.
- Generic throws that stay are integrity assertions: tenant-context and
  timeout verification in `tenant-access/transactions/scope.ts`, migration
  checksums and owner-role checks in `migration-history.ts` and
  `migrations/migrate-database.ts`, missing rows after a write in
  `outbox/events.repository.ts` and `platform/idempotency/repository.ts`,
  pool misuse in `platform/pool/`, and test fixtures in `testing/`.
- Limits are not yet named: database is outside the backend-limits check.
  Most of its literals are column widths, which should come from their
  owners' limits.

## What guards it

- `pnpm --filter @pertexo/database test`: config, pools, idempotency,
  readiness and migration logic without a database.
- `pnpm --filter @pertexo/database test:integration` needs PostgreSQL
  (`DATABASE_URL` and the role URLs): row security, transactions, migrations,
  receipts and readiness.
- `pnpm check`: schema, SQL-function, transaction-setting, module-import,
  package structure, naming and environment checks.
