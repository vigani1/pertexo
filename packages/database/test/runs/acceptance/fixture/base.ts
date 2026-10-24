import { createHash, randomUUID } from 'node:crypto';
import { count } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import { parseDatabaseConfig } from '../../../../src/config.js';
import { createWorkspaceDatabase } from '../../../../src/database.js';
import { createOutboxDispatcherDatabase } from '../../../../src/outbox/dispatcher/repository.js';
import { migrateDatabase } from '../../../../src/migrations.js';

import { lockRunAcceptanceCommand } from '../../../../src/runs/commands/manual-start.js';
import {
  idempotencyRecords,
  outboxEvents,
  runCheckpoints,
  runEvents,
  workflowRuns,
} from '../../../../src/schema.js';
import { createDisposableDatabaseFixture } from '../../../support/postgres/disposable-database.js';
import type { WorkspaceTransaction } from '../../../../src/tenant-access/transactions.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

const workerBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

const dispatcherBaseUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

const databaseName = `pertexo_test_accept_${randomUUID().replaceAll('-', '')}`;

const disposableDatabase = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  databaseName,
  ownerRole: 'pertexo_owner',
});

export const migrationUrl = disposableDatabase.databaseUrl(migrationBaseUrl);

export const apiUrl = disposableDatabase.databaseUrl(apiBaseUrl);

const workerUrl = disposableDatabase.databaseUrl(workerBaseUrl);

const dispatcherUrl = disposableDatabase.databaseUrl(dispatcherBaseUrl);

export const workspaceA = randomUUID();

export const workspaceB = randomUUID();

export const workflowId = randomUUID();

export const workflowVersionId = randomUUID();

export const keyHash = createHash('sha256')
  .update('acceptance-key')
  .digest('hex');

export const requestHash = createHash('sha256')
  .update('request-a')
  .digest('hex');

export const otherRequestHash = createHash('sha256')
  .update('request-b')
  .digest('hex');

export const workspaceCreatorId = randomUUID();

export let apiDatabase: ReturnType<typeof createWorkspaceDatabase>;

export let workerDatabase: ReturnType<typeof createWorkspaceDatabase>;

export let dispatcherDatabase: ReturnType<
  typeof createOutboxDispatcherDatabase
>;

let resourcesCreated = false;

const migrationConfig = {
  appRole: 'pertexo_app',
  connectionString: migrationUrl,
  maintenanceRole: 'pertexo_maintenance',
  ownerRole: 'pertexo_owner',
} as const;

export function hasPostgresCode(
  expectedCode: string,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current = error;
    const visited = new Set<object>();
    for (let depth = 0; depth < 16; depth += 1) {
      if (!(current instanceof Error) || visited.has(current)) return false;
      visited.add(current);
      try {
        if (Reflect.get(current, 'code') === expectedCode) return true;
        current = Reflect.get(current, 'cause');
      } catch {
        return false;
      }
    }
    return false;
  };
}

export function acceptanceInput(
  requestHashOverride = requestHash,
  runInput?: unknown,
) {
  return {
    initialCheckpoint: initialCheckpoint(),
    keyHash,
    operation: 'workflow.run.accept',
    requestHash: requestHashOverride,
    ...(runInput === undefined ? {} : { runInput }),
    scope: `workflow:${workflowId}:manual`,
    // Generic admission tests exercise the API trigger. Explicit manual tests
    // use the same serialized key as the manual command.
    triggerType: 'api',
    workflowId,
    workflowVersionId,
  } as const;
}

/** Explicit manual tests use the command's production key lock. */
export async function lockManualFixtureStart(
  transaction: WorkspaceTransaction,
): Promise<void> {
  await lockRunAcceptanceCommand(transaction, {
    scope: `workflow:${workflowId}:manual`,
    idempotencyKeyHash: keyHash,
  });
}

export function initialCheckpoint() {
  return {
    workflowVersionId,
    revision: 0,
    runStatus: 'queued',
    nextEventSequence: 2,
    readySet: [],
    admittedInvocationKeys: [],
    invocations: [],
    joins: [],
    loops: [],
    remainingIterationBudget: 0,
    cancelRequested: false,
    deadlineExpired: false,
    branchSelections: [],
  } as const;
}

export async function expectAcceptanceRecordCounts(
  expected: number,
): Promise<void> {
  await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
    const tables = [
      idempotencyRecords,
      workflowRuns,
      runEvents,
      runCheckpoints,
      outboxEvents,
    ] as const;
    for (const table of tables) {
      expect(await db.select({ count: count() }).from(table)).toEqual([
        { count: expected },
      ]);
    }
  });
}

export async function waitForDatabaseLock(
  processId: number,
  relationship: 'blocker' | 'waiter' = 'blocker',
): Promise<void> {
  const observer = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await expect
      .poll(
        async () => {
          const result = await observer.query<{ blocked: boolean }>(
            `select exists (
           select 1 from pg_stat_activity
            where ($2::text='blocker' and $1::int=any(pg_blocking_pids(pid)))
               or ($2::text='waiter' and pid=$1::int
                   and cardinality(pg_blocking_pids(pid)) > 0)
         ) blocked`,
            [processId, relationship],
          );
          return result.rows[0]?.blocked ?? false;
        },
        { timeout: 2_000, interval: 10 },
      )
      .toBe(true);
  } finally {
    await observer.end();
  }
}

async function resetExecutionFixture(): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(`
      truncate table
        app.idempotency_records,
        app.run_events,
        app.run_checkpoints,
        app.workflow_runs,
        app.outbox_events,
        app.workflow_failure_notification_policies,
        app.failure_notification_destination_versions,
        app.failure_notification_destinations,
        app.connection_secret_versions,
        app.connections,
        app.workflows
      cascade
    `);
    await client.query(
      `insert into app.users (id, email, display_name, status)
       values ($1, $2, 'Execution fixture owner', 'active')
       on conflict (id) do update set status = 'active'`,
      [workspaceCreatorId, `execution-${workspaceCreatorId}@example.test`],
    );
    await client.query(
      `insert into app.workspaces (id, name, slug, status, created_by)
       values
         ($1, 'Execution A', $3, 'active', $5),
         ($2, 'Execution B', $4, 'active', $5)
        on conflict (id) do update set
          name = excluded.name,
          slug = excluded.slug,
          status = 'active',
          created_by = excluded.created_by,
          deletion_requested_at = null,
         deletion_requested_by = null,
         deletion_reason = null,
         purge_after = null`,
      [
        workspaceA,
        workspaceB,
        `execution-a-${workspaceA}`,
        `execution-b-${workspaceB}`,
        workspaceCreatorId,
      ],
    );
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceA,
    ]);
    await client.query(
      `insert into app.workspace_memberships(workspace_id,user_id,role,status)
      values($1,$2,'owner','active') on conflict(workspace_id,user_id) do update set status='active'`,
      [workspaceA, workspaceCreatorId],
    );
    await client.query(
      `update app.workspace_execution_entitlements set current_version=1
        where workspace_id=$1`,
      [workspaceA],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client?.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

export function installExecutionAcceptanceFixture(): void {
  beforeAll(async () => {
    await disposableDatabase.create();
    try {
      await migrateDatabase(migrationConfig);
      apiDatabase = createWorkspaceDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
      );
      workerDatabase = createWorkspaceDatabase(
        parseDatabaseConfig({ connectionString: workerUrl, max: 2 }),
      );
      dispatcherDatabase = createOutboxDispatcherDatabase(
        parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 }),
      );
      resourcesCreated = true;
    } catch (error: unknown) {
      await disposableDatabase.drop().catch(() => undefined);
      throw error;
    }
  });
  beforeEach(resetExecutionFixture);
  afterAll(async () => {
    const outcomes = resourcesCreated
      ? await Promise.allSettled([
          apiDatabase.close(),
          dispatcherDatabase.close(),
          workerDatabase.close(),
        ])
      : [];
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
    );
    try {
      await disposableDatabase.drop();
    } catch (error: unknown) {
      failures.push(error);
    }
    if (failures.length > 0)
      throw new AggregateError(failures, 'Acceptance fixture cleanup failed');
  });
}
