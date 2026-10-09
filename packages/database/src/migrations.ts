import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool, type PoolClient } from 'pg';

import type { MigrationConfig } from './config.js';

// Stable application namespace for serializing Pertexo schema migrations.
const MIGRATION_LOCK_ID = 7_166_118_812;
const migrationNamePattern = /^\d{4}_[a-z0-9_]+\.sql$/u;
const maximumPostgresTimeoutMs = 2_147_483_647;
const migrationRunnerDefaults = Object.freeze({
  connectionTimeoutMs: 10_000,
  lockTimeoutMs: 10_000,
  statementTimeoutMs: 300_000,
});

function preserveMigrationFailureDuringCleanup(
  migration: Readonly<{ error: unknown; failed: boolean }>,
  cleanupErrors: readonly unknown[],
): void {
  if (cleanupErrors.length === 0) return;
  if (migration.failed)
    throw new AggregateError(
      [migration.error, ...cleanupErrors],
      'Migration failed and database cleanup was incomplete',
    );
  if (cleanupErrors.length === 1) {
    const [cleanupError] = cleanupErrors;
    try {
      if (cleanupError instanceof Error) throw cleanupError;
    } catch (error: unknown) {
      if (error === cleanupError) throw error;
    }
    throw new Error('Migration database cleanup failed', {
      cause: cleanupError,
    });
  }
  throw new AggregateError(
    cleanupErrors,
    'Migration database cleanup was incomplete',
  );
}

export interface MigrationRunnerOptions {
  readonly connectionTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

function parseMigrationTimeout(
  value: number | undefined,
  fallback: number,
  minimum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) ||
    selected < minimum ||
    selected > maximumPostgresTimeoutMs
  )
    throw new TypeError(
      `Migration ${label} timeout must be between ${String(minimum)}ms and ${String(maximumPostgresTimeoutMs)}ms`,
    );
  return selected;
}

export const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../migrations/', import.meta.url),
);

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function renderMigration(sql: string, config: MigrationConfig): string {
  return sql
    .replaceAll('{{owner_role}}', quoteIdentifier(config.ownerRole))
    .replaceAll('{{app_role}}', quoteIdentifier(config.appRole))
    .replaceAll(
      '{{maintenance_role}}',
      quoteIdentifier(config.maintenanceRole),
    );
}

async function migrationNames(directory: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((name) => migrationNamePattern.test(name))
    .sort();
}

export async function migrateDatabase(
  config: MigrationConfig,
  migrationsDirectory = MIGRATIONS_DIRECTORY,
  runnerOptions: MigrationRunnerOptions = {},
): Promise<readonly string[]> {
  const applied: string[] = [];
  const connectionTimeoutMs = parseMigrationTimeout(
    runnerOptions.connectionTimeoutMs,
    migrationRunnerDefaults.connectionTimeoutMs,
    100,
    'connection',
  );
  const lockTimeoutMs = parseMigrationTimeout(
    runnerOptions.lockTimeoutMs,
    migrationRunnerDefaults.lockTimeoutMs,
    100,
    'lock',
  );
  const statementTimeoutMs = parseMigrationTimeout(
    runnerOptions.statementTimeoutMs,
    migrationRunnerDefaults.statementTimeoutMs,
    1_000,
    'statement',
  );
  const pool = new Pool({
    connectionString: config.connectionString,
    connectionTimeoutMillis: connectionTimeoutMs,
    max: 1,
  });
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error: unknown) {
    try {
      await pool.end();
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        'Migration connection acquisition and pool cleanup failed',
      );
    }
    // Preserve legacy non-Error adapter rejection values.
    throw error;
  }
  const transaction = async <T>(work: () => Promise<T>): Promise<T> => {
    await client.query('begin');
    try {
      await client.query(`set local role ${quoteIdentifier(config.ownerRole)}`);
      await client.query("select set_config('lock_timeout',$1,true)", [
        `${String(lockTimeoutMs)}ms`,
      ]);
      await client.query("select set_config('statement_timeout',$1,true)", [
        `${String(statementTimeoutMs)}ms`,
      ]);
      const result = await work();
      await client.query('commit');
      return result;
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    }
  };

  let migration = { error: undefined as unknown, failed: false };
  try {
    const names = await migrationNames(migrationsDirectory);

    await client.query("select set_config('statement_timeout',$1,false)", [
      `${String(statementTimeoutMs)}ms`,
    ]);
    await client.query("select set_config('lock_timeout',$1,false)", [
      `${String(lockTimeoutMs)}ms`,
    ]);
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`set role ${quoteIdentifier(config.ownerRole)}`);
    await transaction(async () => {
      const roleResult = await client.query<{ current_user: string }>(
        'select current_user',
      );
      if (roleResult.rows[0]?.current_user !== config.ownerRole)
        throw new Error('Migration owner role verification failed');
      await client.query('create schema if not exists pertexo_internal');
      await client.query('revoke all on schema pertexo_internal from public');
      await client.query(`
        create table if not exists pertexo_internal.schema_migrations (
          name text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )
      `);
    });

    const known = new Set(names);
    const recorded = await client.query<{ name: string; checksum: string }>(
      'select name,checksum from pertexo_internal.schema_migrations',
    );
    const appliedChecksums = new Map(
      recorded.rows.map((row) => [row.name, row.checksum]),
    );
    if (recorded.rows.some((row) => !known.has(row.name)))
      throw new Error(
        'Database was migrated from an older migration history; recreate it',
      );
    for (const name of names) {
      const sql = await readFile(path.join(migrationsDirectory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const appliedChecksum = appliedChecksums.get(name);
      if (appliedChecksum !== undefined) {
        if (appliedChecksum !== checksum)
          throw new Error(`Applied migration checksum changed: ${name}`);
        continue;
      }
      await transaction(async () => {
        await client.query(renderMigration(sql, config));
        await client.query(
          'insert into pertexo_internal.schema_migrations(name,checksum) values($1,$2)',
          [name, checksum],
        );
      });
      applied.push(name);
    }

    await transaction(async () => {
      await client.query(
        `grant usage on schema pertexo_internal to ${quoteIdentifier(config.appRole)}, ${quoteIdentifier(config.maintenanceRole)}`,
      );
      await client.query(
        `grant select on pertexo_internal.schema_migrations to ${quoteIdentifier(config.appRole)}, ${quoteIdentifier(config.maintenanceRole)}`,
      );
    });
    return Object.freeze(applied);
  } catch (error) {
    migration = { error, failed: true };
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await client.query('reset role');
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (cleanupErrors.length > 0) client.release(true);
      else client.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await pool.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
    preserveMigrationFailureDuringCleanup(migration, cleanupErrors);
  }
}
