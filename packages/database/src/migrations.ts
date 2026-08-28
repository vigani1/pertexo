import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import type { MigrationConfig } from './config.js';

// Stable application namespace for serializing Pertexo schema migrations.
const MIGRATION_LOCK_ID = 7_166_118_812;
const migrationNamePattern = /^\d{4}_[a-z0-9_]+\.sql$/u;

// These checksums were published before corrections were folded back into the
// numbered migration files. They remain accepted only when the corrected file
// produces the same final schema or lets an affected database reach a
// forward-only reconciliation migration.
const publishedMigrationChecksums: Readonly<
  Record<string, ReadonlySet<string>>
> = Object.freeze({
  '0037_failure_notification_destinations.sql': new Set([
    '9f76e5fefc3914a808cb000f796760e17902876a4418d006bb82674d7778eede',
  ]),
  '0038_execution_admission.sql': new Set([
    '89117c0311337b655503557f7a66f63c04aa9eb6736be6ddfc4b02dea4eedf95',
    '0b7c70eee52daefeacbd092e1831852aa4260b60b899832b565ec524e47b2be2',
    '27ca68dc5e20560d80fbaab2524b3cd0c9fe0361b68792538a69aac30d4f9857',
  ]),
  '0070_preview_execution_deadline.sql': new Set([
    'beabac6354d519a98878e57645d74c8afa8c46454bf13fc3886835774da0c914',
  ]),
});

export const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../migrations/', import.meta.url),
);

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function renderMigration(sql: string, config: MigrationConfig): string {
  return sql
    .replaceAll('{{owner_role}}', quoteIdentifier(config.ownerRole))
    .replaceAll('{{api_runtime_role}}', quoteIdentifier(config.apiRuntimeRole))
    .replaceAll('{{dispatcher_role}}', quoteIdentifier(config.dispatcherRole))
    .replaceAll('{{maintenance_role}}', quoteIdentifier(config.maintenanceRole))
    .replaceAll(
      '{{lifecycle_command_role}}',
      quoteIdentifier(config.lifecycleCommandRole),
    )
    .replaceAll('{{operator_role}}', quoteIdentifier(config.operatorRole))
    .replaceAll(
      '{{worker_runtime_role}}',
      quoteIdentifier(config.workerRuntimeRole),
    )
    .replaceAll(
      '{{regional_write_admission_enforced}}',
      config.regionalWriteAdmissionEnforced === true ? 'true' : 'false',
    );
}

export function isCompatibleMigrationChecksum(
  name: string,
  expectedChecksum: string,
  appliedChecksum: string,
): boolean {
  return (
    appliedChecksum === expectedChecksum ||
    publishedMigrationChecksums[name]?.has(appliedChecksum) === true
  );
}

export async function migrateDatabase(
  config: MigrationConfig,
  migrationsDirectory = MIGRATIONS_DIRECTORY,
): Promise<readonly string[]> {
  const pool = new Pool({ connectionString: config.connectionString, max: 1 });
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query('begin');
    await client.query(`set local role ${quoteIdentifier(config.ownerRole)}`);
    const roleResult = await client.query<{ current_user: string }>(
      'select current_user',
    );
    if (roleResult.rows[0]?.current_user !== config.ownerRole) {
      throw new Error('Migration owner role verification failed');
    }

    await client.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query('create schema if not exists pertexo_internal');
    await client.query('revoke all on schema pertexo_internal from public');
    await client.query(`
      create table if not exists pertexo_internal.schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const migrationNames = (await readdir(migrationsDirectory))
      .filter((name) => migrationNamePattern.test(name))
      .sort();

    for (const name of migrationNames) {
      const sql = await readFile(path.join(migrationsDirectory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum: string }>(
        'select checksum from pertexo_internal.schema_migrations where name = $1',
        [name],
      );

      if (existing.rows[0] !== undefined) {
        if (
          !isCompatibleMigrationChecksum(
            name,
            checksum,
            existing.rows[0].checksum,
          )
        ) {
          throw new Error(`Applied migration checksum changed: ${name}`);
        }
        continue;
      }

      await client.query(renderMigration(sql, config));
      await client.query(
        'insert into pertexo_internal.schema_migrations (name, checksum) values ($1, $2)',
        [name, checksum],
      );
      applied.push(name);
    }

    await client.query(
      `grant usage on schema pertexo_internal to ${quoteIdentifier(config.apiRuntimeRole)}, ${quoteIdentifier(config.workerRuntimeRole)}, ${quoteIdentifier(config.dispatcherRole)}, ${quoteIdentifier(config.maintenanceRole)}, ${quoteIdentifier(config.lifecycleCommandRole)}, ${quoteIdentifier(config.operatorRole)}`,
    );
    await client.query(
      `grant select on pertexo_internal.schema_migrations to ${quoteIdentifier(config.apiRuntimeRole)}, ${quoteIdentifier(config.workerRuntimeRole)}, ${quoteIdentifier(config.dispatcherRole)}, ${quoteIdentifier(config.maintenanceRole)}, ${quoteIdentifier(config.lifecycleCommandRole)}, ${quoteIdentifier(config.operatorRole)}`,
    );
    await client.query('commit');
    return Object.freeze(applied);
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
