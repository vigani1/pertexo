import { createHash, randomUUID } from 'node:crypto';

import { count, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createWorkspaceDatabase } from '../src/database.js';
import { createOutboxDispatcherDatabase } from '../src/execution/dispatcher.js';
import { migrateDatabase } from '../src/migrations.js';
import {
  idempotencyRecords,
  outboxEvents,
  runCheckpoints,
  runEvents,
  workflowRuns,
} from '../src/schema.js';

export const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
export const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const dispatcherUrl =
  process.env.DATABASE_DISPATCHER_URL ??
  'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo';

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

export const apiDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
);
export const workerDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: workerUrl, max: 2 }),
);
export const dispatcherDatabase = createOutboxDispatcherDatabase(
  parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 }),
);

const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
  maintenanceRole: 'pertexo_maintenance',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

export function hasPostgresCode(
  expectedCode: string,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current = error;
    while (current instanceof Error) {
      if ('code' in current && current.code === expectedCode) return true;
      current = current.cause;
    }
    return false;
  };
}

export function acceptanceInput(
  requestHashOverride = requestHash,
  runInput?: unknown,
) {
  return {
    engineVersion: 'phase0-engine-v1',
    initialCheckpoint: initialCheckpoint(),
    keyHash,
    operation: 'workflow.run.accept',
    requestHash: requestHashOverride,
    ...(runInput === undefined ? {} : { runInput }),
    scope: `workflow:${workflowId}:manual`,
    triggerType: 'manual',
    workflowId,
    workflowVersionId,
  } as const;
}

export function initialCheckpoint() {
  return {
    schemaVersion: 1,
    engineVersion: 'phase0-engine-v1',
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
  const deadline = Date.now() + 2_000;
  try {
    while (Date.now() < deadline) {
      const result = await observer.query<{ blocked: boolean }>(
        `select exists (
           select 1 from pg_stat_activity
            where ($2::text='blocker' and $1::int=any(pg_blocking_pids(pid)))
               or ($2::text='waiter' and pid=$1::int
                   and cardinality(pg_blocking_pids(pid)) > 0)
         ) blocked`,
        [processId, relationship],
      );
      if (result.rows[0]?.blocked === true) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Timed out waiting for ${relationship} database process ${String(processId)}`,
    );
  } finally {
    await observer.end();
  }
}

async function resetExecutionFixture(): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(`
      truncate table
        app.workspace_purge_steps,
        app.workspace_purge_jobs,
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
    await client.query(`
      update app.regional_write_admission
         set enforced=false,status='open',replay_lag_millis=null,
             observed_at=null,updated_at=now()
       where singleton
    `);
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
      `update app.workspace_execution_entitlements set current_version=1
        where workspace_id=$1`,
      [workspaceA],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function createNotificationFixture(
  input: Readonly<{
    connectionKind?: 'email' | 'slack';
    destinationKind?: 'email' | 'slack';
  }> = {},
): Promise<
  Readonly<{
    connectionId: string;
    destinationId: string;
    secretVersionId: string;
  }>
> {
  const connectionKind = input.connectionKind ?? 'email';
  const destinationKind = input.destinationKind ?? 'email';
  const connectionId = randomUUID();
  const destinationId = randomUUID();
  const secretVersionId = randomUUID();
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  const protectedTables = [
    'workflows',
    'connections',
    'connection_secret_versions',
    'failure_notification_destinations',
    'failure_notification_destination_versions',
  ] as const;
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceA,
    ]);
    for (const table of protectedTables)
      await client.query(
        `alter table app.${table} no force row level security`,
      );
    await client.query(
      `insert into app.workflows (id,workspace_id,name,created_by)
       values ($1,$2,'Notification pin fixture',$3)
       on conflict (id) do nothing`,
      [workflowId, workspaceA, workspaceCreatorId],
    );
    await client.query(
      `insert into app.connections (
         id,workspace_id,provider_key,name,auth_type,status,
         current_secret_version_id,created_by
       ) values ($1,$2,$3,$7,$4,'active',$5,$6)`,
      [
        connectionId,
        workspaceA,
        connectionKind,
        connectionKind === 'slack' ? 'slack_bot_token' : 'resend_api_key',
        secretVersionId,
        workspaceCreatorId,
        `Notification pin ${connectionId}`,
      ],
    );
    await client.query(
      `insert into app.connection_secret_versions (
         id,workspace_id,connection_id,schema_version,kms_key_reference,
         encrypted_data_key,ciphertext,nonce,auth_tag,created_by
       ) values ($1,$2,$3,1,'kms','key','cipher','AAAAAAAAAAAAAAAA',
         'AAAAAAAAAAAAAAAAAAAAAA',$4)`,
      [secretVersionId, workspaceA, connectionId, workspaceCreatorId],
    );
    await client.query(
      `insert into app.failure_notification_destinations
         (id,workspace_id,kind,status,current_config_version,created_by)
       values ($1,$2,$3,'enabled',1,$4)`,
      [destinationId, workspaceA, destinationKind, workspaceCreatorId],
    );
    await client.query(
      `insert into app.failure_notification_destination_versions
         (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
       values ($1,$2,1,$3,$4,$5::jsonb,$6)`,
      [
        workspaceA,
        destinationId,
        destinationKind,
        destinationKind === 'slack' ? 'unsafe' : 'idempotent_with_key',
        JSON.stringify(
          destinationKind === 'slack'
            ? { connectionId, channelId: 'C12345' }
            : { connectionId, toEmail: 'pin@example.test' },
        ),
        workspaceCreatorId,
      ],
    );
    await client.query('set constraints all immediate');
    for (const table of protectedTables)
      await client.query(`alter table app.${table} force row level security`);
    await client.query('commit');
    return { connectionId, destinationId, secretVersionId };
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function insertDirectPinnedRun(
  pin: Readonly<{
    destinationId: string;
    secretVersionId: string;
    sideEffectClass: 'idempotent_with_key' | 'unsafe';
  }>,
): Promise<void> {
  await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
    db
      .execute(
        sql`
      insert into app.workflow_runs (
        id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
        failure_notification_policy_version,
        failure_notification_destination_id,
        failure_notification_destination_config_version,
        failure_notification_side_effect_class,
        failure_notification_connection_secret_version_id
      ) values (${randomUUID()},${workspaceA},${workflowId},${workflowVersionId},
        'manual','queued',1,${pin.destinationId},1,${pin.sideEffectClass},
        ${pin.secretVersionId})
    `,
      )
      .then(() => undefined),
  );
}

export async function setFixtureStatus(
  table: 'connections' | 'failure_notification_destinations' | 'workspaces',
  id: string,
  status: string,
): Promise<void> {
  const pool = new Pool({
    connectionString: table === 'workspaces' ? migrationUrl : apiUrl,
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (table === 'workspaces')
      await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceA,
    ]);
    const updated = await client.query(
      `update app.${table} set status=$2 where id=$1`,
      [id, status],
    );
    if (updated.rowCount !== 1) throw new Error('Fixture status update failed');
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function setNotificationPolicy(
  destinationId: string,
): Promise<void> {
  const pool = new Pool({ connectionString: apiUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceA,
    ]);
    await client.query(
      `insert into app.workflow_failure_notification_policies
         (workspace_id,workflow_id,destination_id,updated_by)
       values ($1,$2,$3,$4)`,
      [workspaceA, workflowId, destinationId, workspaceCreatorId],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export function installExecutionAcceptanceFixture(): void {
  beforeAll(async () => {
    await migrateDatabase(migrationConfig);
  });
  beforeEach(resetExecutionFixture);
  afterAll(async () => {
    await Promise.all([
      apiDatabase.close(),
      dispatcherDatabase.close(),
      workerDatabase.close(),
    ]);
  });
}
