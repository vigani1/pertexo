import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool, type PoolClient } from 'pg';

import type { MigrationConfig } from './config.js';
import {
  loadMigrationExecutionPlan,
  type MigrationExecution,
} from './migration-execution-plan.js';

// Stable application namespace for serializing Pertexo schema migrations.
const MIGRATION_LOCK_ID = 7_166_118_812;
const migrationNamePattern = /^\d{4}_[a-z0-9_]+\.sql$/u;
const migrationRunnerOptionsSchema = Object.freeze({
  lockTimeoutMs: 10_000,
  statementTimeoutMs: 300_000,
});

export type MigrationProgressEvent = Readonly<{
  batchesCompleted?: number;
  mode: MigrationExecution['mode'];
  name: string;
  phase: 'completed' | 'started';
  rowsProcessed?: number;
}>;

export interface MigrationRunnerOptions {
  readonly lockTimeoutMs?: number;
  readonly onProgress?: (event: MigrationProgressEvent) => void;
  readonly statementTimeoutMs?: number;
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

type MigrationTransaction = <T>(work: () => Promise<T>) => Promise<T>;

async function runNonTransactionalMigration(input: {
  readonly checksum: string;
  readonly client: PoolClient;
  readonly config: MigrationConfig;
  readonly emitProgress: (event: MigrationProgressEvent) => void;
  readonly execution: Exclude<MigrationExecution, { mode: 'transactional' }>;
  readonly lockTimeoutMs: number;
  readonly name: string;
  readonly rendered: string;
  readonly transaction: MigrationTransaction;
}): Promise<void> {
  const size = await input.client.query<{ bytes: string }>(
    'select pg_database_size(current_database())::text bytes',
  );
  const databaseBytes = Number(size.rows[0]?.bytes);
  if (!Number.isSafeInteger(databaseBytes) || databaseBytes < 0)
    throw new Error(
      `Migration database-size preflight was invalid: ${input.name}`,
    );
  if (databaseBytes > input.execution.maximumDatabaseBytes)
    throw new Error(`Migration database-size preflight failed: ${input.name}`);

  if (input.execution.mode === 'online') {
    if (/\b(?:BEGIN|COMMIT|ROLLBACK)\b/iu.test(input.rendered))
      throw new Error(
        `Online migration controls transactions directly: ${input.name}`,
      );
    await input.client.query(
      `set role ${quoteIdentifier(input.config.ownerRole)}`,
    );
    try {
      await input.client.query("select set_config('lock_timeout',$1,false)", [
        `${String(input.lockTimeoutMs)}ms`,
      ]);
      await input.client.query(input.rendered);
    } finally {
      await input.client.query('reset role').catch(() => undefined);
    }
    await input.transaction(() =>
      input.client.query(
        'insert into pertexo_internal.schema_migrations (name, checksum) values ($1, $2)',
        [input.name, input.checksum],
      ),
    );
    return;
  }

  let completed = false;
  for (let batch = 0; batch < input.execution.batchLimit; batch += 1) {
    const progress = await input.transaction(async () => {
      await input.client.query(
        `insert into pertexo_internal.migration_jobs(name,checksum)
         values($1,$2) on conflict(name) do nothing`,
        [input.name, input.checksum],
      );
      const job = await input.client.query<{
        batches_completed: string;
        checksum: string;
        rows_processed: string;
        status: string;
      }>(
        `select checksum,batches_completed::text,rows_processed::text,status
         from pertexo_internal.migration_jobs where name=$1 for update`,
        [input.name],
      );
      const current = job.rows[0];
      if (current?.checksum !== input.checksum)
        throw new Error(`Resumable migration checksum changed: ${input.name}`);
      if (current.status === 'completed')
        return {
          batchesCompleted: Number(current.batches_completed),
          completed: true,
          rowsProcessed: Number(current.rows_processed),
        };
      const result = await input.client.query<{
        completed: boolean;
        processed_count: string | number;
      }>(input.rendered);
      const row = result.rows[0];
      const processed = Number(row?.processed_count);
      if (
        typeof row?.completed !== 'boolean' ||
        !Number.isSafeInteger(processed) ||
        processed < 0
      )
        throw new Error(
          `Resumable migration returned invalid progress: ${input.name}`,
        );
      const updated = await input.client.query<{
        batches_completed: string;
        rows_processed: string;
      }>(
        `update pertexo_internal.migration_jobs set
           batches_completed=batches_completed+1,
           rows_processed=rows_processed+$2,
           status=case when $3 then 'completed' else 'pending' end,
           updated_at=clock_timestamp()
         where name=$1 returning batches_completed::text,rows_processed::text`,
        [input.name, processed, row.completed],
      );
      if (row.completed)
        await input.client.query(
          'insert into pertexo_internal.schema_migrations(name,checksum) values($1,$2)',
          [input.name, input.checksum],
        );
      return {
        batchesCompleted: Number(updated.rows[0]?.batches_completed),
        completed: row.completed,
        rowsProcessed: Number(updated.rows[0]?.rows_processed),
      };
    });
    input.emitProgress({
      batchesCompleted: progress.batchesCompleted,
      mode: input.execution.mode,
      name: input.name,
      phase: progress.completed ? 'completed' : 'started',
      rowsProcessed: progress.rowsProcessed,
    });
    if (progress.completed) {
      completed = true;
      break;
    }
  }
  if (!completed)
    throw new Error(
      `Resumable migration requires another bounded run: ${input.name}`,
    );
}

export async function migrateDatabase(
  config: MigrationConfig,
  migrationsDirectory = MIGRATIONS_DIRECTORY,
  runnerOptions: MigrationRunnerOptions = {},
): Promise<readonly string[]> {
  const applied: string[] = [];
  const lockTimeoutMs =
    runnerOptions.lockTimeoutMs ?? migrationRunnerOptionsSchema.lockTimeoutMs;
  const statementTimeoutMs =
    runnerOptions.statementTimeoutMs ??
    migrationRunnerOptionsSchema.statementTimeoutMs;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 100)
    throw new TypeError('Migration lock timeout must be at least 100ms');
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 1_000)
    throw new TypeError('Migration statement timeout must be at least 1000ms');
  const pool = new Pool({ connectionString: config.connectionString, max: 1 });
  const client = await pool.connect().catch(async (error: unknown) => {
    await pool.end();
    throw error;
  });
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

  try {
    const migrationNames = (await readdir(migrationsDirectory))
      .filter((name) => migrationNamePattern.test(name))
      .sort();
    const executionPlan = await loadMigrationExecutionPlan(
      migrationsDirectory,
      migrationNames,
      {
        required:
          path.resolve(migrationsDirectory) ===
          path.resolve(MIGRATIONS_DIRECTORY),
      },
    );

    await client.query("select set_config('statement_timeout',$1,false)", [
      `${String(statementTimeoutMs)}ms`,
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
      if (execution.mode === 'transactional') {
        if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/iu.test(rendered))
          throw new Error(
            `Concurrent index migration must declare online mode: ${name}`,
          );
        await transaction(async () => {
          await client.query(rendered);
          await client.query(
            'insert into pertexo_internal.schema_migrations (name, checksum) values ($1, $2)',
            [name, checksum],
          );
        });
      } else
        await runNonTransactionalMigration({
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
  } finally {
    await client.query('reset role').catch(() => undefined);
    await client
      .query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID])
      .catch(() => undefined);
    client.release();
    await pool.end();
  }
}
