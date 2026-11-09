# Database migrations

Drizzle owns the `app` tables, columns, constraints, indexes and sequences in
`packages/database/src/schema/`. SQL supplies the functions, triggers, workspace
policies, grants, comments, storage settings and singleton seeds that Drizzle
cannot express. Follow ADR 069's SQL rules and the function allowlist when adding
SQL. The migration runner applies each file in its own transaction under the
application migration advisory lock.

## Add a migration

1. Change the typed schema and run `command pnpm db:generate`. Review the generated
   SQL and add any required supplemental SQL. For a SQL-only change, run
   `command pnpm --filter @pertexo/database exec drizzle-kit generate --config=drizzle.config.mjs --custom --name=describe_change`
   (replace `describe_change` with the operation). Edit the empty SQL file it
   creates and commit its matching journal/snapshot metadata too.
2. Update `EXPECTED_MIGRATION_HEAD` in
   `packages/database/src/platform/readiness.repository.ts` to the new filename;
   the head test enforces it. Build with `command pnpm build:packages`. With an isolated Compose PostgreSQL
   stack running and its database environment exported, run
   `node infrastructure/checks/database-catalog.mjs --write` from the repository
   root. It creates, migrates and drops its own disposable database.
3. Review and commit `packages/database/schema.sql` with the migration. Run the same
   command without `--write` to check the committed snapshot. The existing database
   integration CI job runs this check. It includes functions, triggers, policies,
   table and column grants, reloptions, comments and constraint names; patch-version
   banners and random dump restriction tokens are excluded.
4. Add behavior tests, run the database integration suite and `command pnpm check`.
   Update the [data dictionary](data-dictionary.md) when tables or ownership change.

Before the first index on a populated large table, build the nontransactional
migration path described in [architecture](../architecture.md). The current
runner cannot execute `CREATE INDEX CONCURRENTLY`.

## Baseline and existing installations

`0000_baseline.sql` replaces the history through `0122_hot_table_maintenance.sql`.
Its generation provenance is in `migrations/baseline-generation.json`; the
committed catalog is identical to that full history. The two initial data rows
are the instance-capacity settings and fair-dispatch cursor.

`migrations/pre-baseline-history.json` is frozen release history, not a list to
regenerate when adding a migration. It records all 123 original names and raw-file
SHA-256 checksums. The runner classifies recorded history against that manifest
before checking the new baseline's checksum. Exact full history is adopted by
replacing receipts in one transaction under the existing advisory lock. No
baseline schema SQL runs, and later migrations apply normally. Empty databases
execute the baseline. Partial, unknown or altered history is refused.

Operators must follow the required release stop in [Upgrading](upgrading.md).
Do not alter recorded checksums or recreate a populated database to cross the
baseline boundary.
