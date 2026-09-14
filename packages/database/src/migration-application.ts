import type { PoolClient } from 'pg';

import type { MigrationConfig } from './config.js';
import type { MigrationExecution } from './migration-execution-plan.js';
import type { MigrationProgressEvent } from './migrations.js';

type MigrationTransaction = <T>(work: () => Promise<T>) => Promise<T>;

type MigrationApplicationInput = Readonly<{
  checksum: string;
  client: PoolClient;
  config: MigrationConfig;
  emitProgress: (event: MigrationProgressEvent) => void;
  execution: MigrationExecution;
  lockTimeoutMs: number;
  name: string;
  rendered: string;
  transaction: MigrationTransaction;
}>;

type NonTransactionalMigrationInput = MigrationApplicationInput &
  Readonly<{
    execution: Exclude<MigrationExecution, { mode: 'transactional' }>;
  }>;

const historicalOwnerBackfillTables: Readonly<
  Partial<Record<string, readonly string[]>>
> = Object.freeze({
  '0006_execution_vocabulary.sql': Object.freeze([
    'app.workflow_runs',
    'app.idempotency_records',
  ]),
  '0007_execution_runtime.sql': Object.freeze(['app.run_events']),
});

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteQualifiedIdentifier(identifier: string): string {
  return identifier.split('.').map(quoteIdentifier).join('.');
}

async function assertMigrationDatabaseSize(
  input: NonTransactionalMigrationInput,
): Promise<void> {
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
}

async function runOnlineMigration(
  input: NonTransactionalMigrationInput,
): Promise<void> {
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
}

async function runResumableMigration(
  input: NonTransactionalMigrationInput,
  execution: Extract<MigrationExecution, { mode: 'resumable' }>,
): Promise<void> {
  let completed = false;
  for (let batch = 0; batch < execution.batchLimit; batch += 1) {
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
      mode: execution.mode,
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

async function runNonTransactionalMigration(
  input: NonTransactionalMigrationInput,
): Promise<void> {
  await assertMigrationDatabaseSize(input);
  if (input.execution.mode === 'online') {
    await runOnlineMigration(input);
    return;
  }
  await runResumableMigration(input, input.execution);
}

async function runTransactionalMigration(
  input: MigrationApplicationInput,
): Promise<void> {
  if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/iu.test(input.rendered))
    throw new Error(
      `Concurrent index migration must declare online mode: ${input.name}`,
    );
  await input.transaction(async () => {
    const ownerBackfillTables = historicalOwnerBackfillTables[input.name] ?? [];
    for (const table of ownerBackfillTables)
      await input.client.query(
        `alter table ${quoteQualifiedIdentifier(table)} no force row level security`,
      );
    await input.client.query(input.rendered);
    for (const table of ownerBackfillTables)
      await input.client.query(
        `alter table ${quoteQualifiedIdentifier(table)} force row level security`,
      );
    await input.client.query(
      'insert into pertexo_internal.schema_migrations (name, checksum) values ($1, $2)',
      [input.name, input.checksum],
    );
  });
}

export async function applyMigrationExecution(
  input: MigrationApplicationInput,
): Promise<void> {
  if (input.execution.mode === 'transactional') {
    await runTransactionalMigration(input);
    return;
  }
  await runNonTransactionalMigration({
    ...input,
    execution: input.execution,
  });
}
