import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import type { DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';
import { checkDatabaseReadiness } from '../src/readiness.js';
import {
  EXECUTION_JSONB_DATABASE_BACKSTOP_BYTES_V1,
  serializeStoredExecutionValueV1,
} from '../src/stored-execution-value.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';

const cleanDatabaseName = `pertexo_test_0014_clean_${randomUUID().replaceAll('-', '')}`;
const upgradeDatabaseName = `pertexo_test_0014_upgrade_${randomUUID().replaceAll('-', '')}`;
const databaseNames = [cleanDatabaseName, upgradeDatabaseName] as const;
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const runId = randomUUID();
const workflowVersionId = randomUUID();
const nodeRunId = randomUUID();
const nodeAttemptId = randomUUID();

function databaseUrl(base: string, databaseName: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function migrationConfig(databaseName: string) {
  return {
    apiRuntimeRole: 'pertexo_api',
    connectionString: databaseUrl(migrationBaseUrl, databaseName),
    dispatcherRole: 'pertexo_dispatcher',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  } as const;
}

function pgCode(expected: string): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof Error && (error as DatabaseError).code === expected;
}

async function createIsolatedDatabase(name: string): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${name}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${name}" from public`);
    await admin.query(
      `grant connect on database "${name}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
    );
  } finally {
    await admin.end();
  }
}

async function dropIsolatedDatabase(name: string): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, name);
  } finally {
    await admin.end();
  }
}

async function migrateThrough0013(databaseName: string): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-0013-'));
  try {
    const migrations = (await readdir(MIGRATIONS_DIRECTORY)).filter(
      (name) => /^\d{4}_.+\.sql$/u.test(name) && name < '0014_',
    );
    await Promise.all(
      migrations.map((name) =>
        copyFile(
          path.join(MIGRATIONS_DIRECTORY, name),
          path.join(directory, name),
        ),
      ),
    );
    await migrateDatabase(migrationConfig(databaseName), directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function withOwner(
  databaseName: string,
  operation: (pool: Pool) => Promise<void>,
): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl(migrationBaseUrl, databaseName),
    max: 1,
  });
  try {
    await pool.query('begin');
    await pool.query('set local role pertexo_owner');
    await pool.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    await operation(pool);
    await pool.query('commit');
  } catch (error: unknown) {
    await pool.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
}

async function withRuntime<T>(
  baseUrl: string,
  databaseName: string,
  scopedWorkspaceId: string,
  operation: (pool: Pool) => Promise<T>,
): Promise<T> {
  const pool = new Pool({
    connectionString: databaseUrl(baseUrl, databaseName),
    max: 1,
  });
  try {
    await pool.query('begin');
    await pool.query("select set_config('app.workspace_id', $1, true)", [
      scopedWorkspaceId,
    ]);
    const result = await operation(pool);
    await pool.query('commit');
    return result;
  } catch (error: unknown) {
    await pool.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
}

beforeAll(async () => {
  for (const name of databaseNames) {
    await dropIsolatedDatabase(name);
    await createIsolatedDatabase(name);
  }
  await migrateDatabase(migrationConfig(cleanDatabaseName));
  await migrateThrough0013(upgradeDatabaseName);
  await withRuntime(
    apiBaseUrl,
    upgradeDatabaseName,
    workspaceId,
    async (pool) => {
      await pool.query(
        `insert into app.workflow_runs
         (id, workspace_id, workflow_id, workflow_version_id, trigger_type, status, output_ref)
       values ($1, $2, $3, $4, 'manual', 'queued', $5::jsonb)`,
        [
          runId,
          workspaceId,
          randomUUID(),
          workflowVersionId,
          JSON.stringify({ inline: { retained: true } }),
        ],
      );
      await pool.query(
        `insert into app.run_checkpoints
         (workflow_run_id, workspace_id, revision, engine_version, scheduler_state)
       values ($1, $2, 0, 'phase0', '{}'::jsonb)`,
        [runId, workspaceId],
      );
    },
  );
  await withRuntime(
    workerBaseUrl,
    upgradeDatabaseName,
    workspaceId,
    async (pool) => {
      await pool.query(
        `insert into app.node_runs
         (id, workspace_id, workflow_run_id, node_id, invocation_key, status,
          side_effect_class, input_ref, output_ref)
       values ($1, $2, $3, 'set', 'set', 'succeeded', 'safe', $4::jsonb, $4::jsonb)`,
        [
          nodeRunId,
          workspaceId,
          runId,
          JSON.stringify({ inline: { retained: true } }),
        ],
      );
      await pool.query(
        `insert into app.node_attempts
         (id, workspace_id, node_run_id, attempt_number, status,
          side_effect_class, output_ref)
       values ($1, $2, $3, 1, 'succeeded', 'safe', $4::jsonb)`,
        [
          nodeAttemptId,
          workspaceId,
          nodeRunId,
          JSON.stringify({ inline: { retained: true } }),
        ],
      );
    },
  );
  await migrateDatabase(migrationConfig(upgradeDatabaseName));
}, 60_000);

afterAll(async () => {
  for (const name of databaseNames) await dropIsolatedDatabase(name);
});

describe('execution value persistence migration', () => {
  it('migrates clean zero to 0014 with role-aware readiness', async () => {
    for (const [base, expectedRole] of [
      [apiBaseUrl, 'pertexo_api'],
      [workerBaseUrl, 'pertexo_worker'],
    ] as const) {
      const pool = new Pool({
        connectionString: databaseUrl(base, cleanDatabaseName),
        max: 1,
      });
      try {
        await expect(
          checkDatabaseReadiness(pool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).resolves.toMatchObject({
          migrationHead: '0037_failure_notification_destinations.sql',
          role: expectedRole,
        });
      } finally {
        await pool.end();
      }
    }
  });

  it('upgrades retained 0013 refs and checkpoint bodies unchanged', async () => {
    const result = await withRuntime(
      apiBaseUrl,
      upgradeDatabaseName,
      workspaceId,
      async (pool) =>
        pool.query<{
          checkpoint: unknown;
          attempt_output: unknown;
          node_input: unknown;
          node_output: unknown;
          run_output: unknown;
        }>(
          `select checkpoint.scheduler_state as checkpoint,
                attempt.output_ref as attempt_output,
                node.input_ref as node_input, node.output_ref as node_output,
                run.output_ref as run_output
         from app.workflow_runs run
         join app.run_checkpoints checkpoint on checkpoint.workflow_run_id = run.id
         join app.node_runs node on node.workflow_run_id = run.id
         join app.node_attempts attempt on attempt.node_run_id = node.id
         where run.id = $1`,
          [runId],
        ),
    );
    expect(result.rows[0]).toEqual({
      checkpoint: {},
      attempt_output: { inline: { retained: true } },
      node_input: { inline: { retained: true } },
      node_output: { inline: { retained: true } },
      run_output: { inline: { retained: true } },
    });
  });

  it('accepts app-valid exponent expansion and rejects clearly over-limit SQL', async () => {
    const exponentHeavy = serializeStoredExecutionValueV1({
      schemaVersion: 1,
      kind: 'inline',
      value: Array.from({ length: 10_000 }, () => 1e308),
    });
    expect(Buffer.byteLength(exponentHeavy, 'utf8')).toBeLessThan(262_144);

    await withRuntime(
      apiBaseUrl,
      upgradeDatabaseName,
      workspaceId,
      async (pool) => {
        await expect(
          pool.query(
            `insert into app.workflow_runs
             (id, workspace_id, workflow_id, workflow_version_id, trigger_type, status, input_ref)
           values ($1, $2, $3, $4, 'manual', 'queued', $5::jsonb)`,
            [
              randomUUID(),
              workspaceId,
              randomUUID(),
              randomUUID(),
              exponentHeavy,
            ],
          ),
        ).resolves.toBeDefined();
      },
    );

    const clearlyOver = JSON.stringify({
      payload: 'x'.repeat(EXECUTION_JSONB_DATABASE_BACKSTOP_BYTES_V1),
    });
    await expect(
      withRuntime(
        apiBaseUrl,
        upgradeDatabaseName,
        workspaceId,
        async (pool) => {
          await pool.query(
            `insert into app.workflow_runs
             (id, workspace_id, workflow_id, workflow_version_id, trigger_type, status, input_ref)
           values ($1, $2, $3, $4, 'manual', 'queued', $5::jsonb)`,
            [
              randomUUID(),
              workspaceId,
              randomUUID(),
              randomUUID(),
              clearlyOver,
            ],
          );
        },
      ),
    ).rejects.toSatisfy(pgCode('23514'));
  });

  it('persists an engine-range checkpoint above the legacy bound and rejects a clearly over-limit body', async () => {
    const engineRangeCheckpoint = JSON.stringify({
      schemaVersion: 1,
      engineVersion: `phase3-${'x'.repeat(32_768)}`,
      workflowVersionId,
      revision: 1,
      runStatus: 'running',
      nextEventSequence: 1,
      readySet: [],
      admittedInvocationKeys: [],
      invocations: [],
      joins: [],
      loops: [],
      remainingIterationBudget: 1_000,
      cancelRequested: false,
    });
    expect(Buffer.byteLength(engineRangeCheckpoint, 'utf8')).toBeGreaterThan(
      16_384,
    );
    expect(
      Buffer.byteLength(engineRangeCheckpoint, 'utf8'),
    ).toBeLessThanOrEqual(262_144);
    await withRuntime(
      workerBaseUrl,
      upgradeDatabaseName,
      workspaceId,
      async (pool) => {
        await pool.query(
          `update app.run_checkpoints
           set scheduler_state = $1::jsonb, revision = revision + 1
           where workflow_run_id = $2`,
          [engineRangeCheckpoint, runId],
        );
      },
    );

    const clearlyOver = JSON.stringify({
      payload: 'x'.repeat(EXECUTION_JSONB_DATABASE_BACKSTOP_BYTES_V1),
    });
    await expect(
      withRuntime(
        workerBaseUrl,
        upgradeDatabaseName,
        workspaceId,
        async (pool) => {
          await pool.query(
            `update app.run_checkpoints
             set scheduler_state = $1::jsonb, revision = revision + 1
             where workflow_run_id = $2`,
            [clearlyOver, runId],
          );
        },
      ),
    ).rejects.toSatisfy(pgCode('23514'));
  });

  it('keeps unchanged worker least privilege and workspace isolation', async () => {
    const worker = new Pool({
      connectionString: databaseUrl(workerBaseUrl, upgradeDatabaseName),
      max: 1,
    });
    try {
      await worker.query('begin');
      await worker.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await expect(
        worker.query('select input_ref from app.workflow_runs where id = $1', [
          runId,
        ]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        worker.query(
          'update app.workflow_runs set input_ref = null where id = $1',
          [runId],
        ),
      ).rejects.toSatisfy(pgCode('42501'));
      await worker.query('rollback');

      await worker.query('begin');
      await worker.query("select set_config('app.workspace_id', $1, true)", [
        otherWorkspaceId,
      ]);
      await expect(
        worker.query('select input_ref from app.workflow_runs where id = $1', [
          runId,
        ]),
      ).resolves.toMatchObject({ rowCount: 0 });
      await worker.query('commit');
    } finally {
      await worker.end();
    }
  });

  it('fails readiness when an execution-value backstop drifts', async () => {
    await withOwner(upgradeDatabaseName, async (pool) => {
      await pool.query(
        'alter table app.workflow_runs drop constraint workflow_runs_input_ref_bounded',
      );
      await pool.query(
        `alter table app.workflow_runs add constraint workflow_runs_input_ref_bounded
         check (input_ref is null or octet_length(input_ref::text) <= 4194305)`,
      );
    });
    const api = new Pool({
      connectionString: databaseUrl(apiBaseUrl, upgradeDatabaseName),
      max: 1,
    });
    try {
      await expect(
        checkDatabaseReadiness(api, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).rejects.toThrow('Execution value persistence is incompatible');
    } finally {
      await api.end();
      await withOwner(upgradeDatabaseName, async (pool) => {
        await pool.query(
          'alter table app.workflow_runs drop constraint workflow_runs_input_ref_bounded',
        );
        await pool.query(
          `alter table app.workflow_runs add constraint workflow_runs_input_ref_bounded
           check (input_ref is null or octet_length(input_ref::text) <= 4194304)`,
        );
      });
    }
  });
});
