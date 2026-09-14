import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool, type PoolClient } from 'pg';

import type { MigrationConfig } from './config.js';
import { applyMigrationExecution } from './migration-application.js';
import {
  loadMigrationExecutionPlan,
  type MigrationExecution,
} from './migration-execution-plan.js';

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

export type MigrationProgressEvent = Readonly<{
  batchesCompleted?: number;
  mode: MigrationExecution['mode'];
  name: string;
  phase: 'completed' | 'started';
  rowsProcessed?: number;
}>;

export interface MigrationRunnerOptions {
  readonly connectionTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly onProgress?: (event: MigrationProgressEvent) => void;
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

async function loadMigrations(migrationsDirectory: string): Promise<
  Readonly<{
    names: readonly string[];
    executionPlan: Awaited<ReturnType<typeof loadMigrationExecutionPlan>>;
  }>
> {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => migrationNamePattern.test(name))
    .sort();
  const executionPlan = await loadMigrationExecutionPlan(
    migrationsDirectory,
    names,
    {
      required:
        path.resolve(migrationsDirectory) ===
        path.resolve(MIGRATIONS_DIRECTORY),
    },
  );
  return { names, executionPlan };
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
  const emitProgress = (event: MigrationProgressEvent): void => {
    try {
      runnerOptions.onProgress?.(event);
    } catch {
      // Migration observability must not change schema execution outcomes.
    }
  };

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
    const { names: migrationNames, executionPlan } =
      await loadMigrations(migrationsDirectory);

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
      await client.query(`
        create table if not exists pertexo_internal.migration_jobs (
          name text primary key,
          checksum text not null,
          batches_completed bigint not null default 0 check (batches_completed>=0),
          rows_processed bigint not null default 0 check (rows_processed>=0),
          status text not null default 'pending' check (status in ('pending','completed')),
          updated_at timestamptz not null default now()
        )
      `);
    });

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
      const execution = executionPlan.executionFor(name);
      emitProgress({
        mode: execution.mode,
        name,
        phase: 'started',
      });
      const rendered = renderMigration(sql, config);
      await applyMigrationExecution({
        checksum,
        client,
        config,
        emitProgress,
        execution,
        lockTimeoutMs,
        name,
        rendered,
        transaction,
      });
      applied.push(name);
      emitProgress({
        mode: execution.mode,
        name,
        phase: 'completed',
      });
    }

    await transaction(async () => {
      await client.query(
        `grant usage on schema pertexo_internal to ${quoteIdentifier(config.apiRuntimeRole)}, ${quoteIdentifier(config.workerRuntimeRole)}, ${quoteIdentifier(config.dispatcherRole)}, ${quoteIdentifier(config.maintenanceRole)}, ${quoteIdentifier(config.lifecycleCommandRole)}, ${quoteIdentifier(config.operatorRole)}`,
      );
      await client.query(
        `grant select on pertexo_internal.schema_migrations to ${quoteIdentifier(config.apiRuntimeRole)}, ${quoteIdentifier(config.workerRuntimeRole)}, ${quoteIdentifier(config.dispatcherRole)}, ${quoteIdentifier(config.maintenanceRole)}, ${quoteIdentifier(config.lifecycleCommandRole)}, ${quoteIdentifier(config.operatorRole)}`,
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
