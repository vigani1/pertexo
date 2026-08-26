import { createHash, randomUUID } from 'node:crypto';

import { count, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createWorkspaceDatabase } from '../src/database.js';
import { createOutboxDispatcherDatabase } from '../src/dispatcher.js';
import {
  acceptWorkflowRun,
  IDEMPOTENCY_STATUS_VALUES,
  IdempotencyRequestConflictError,
  RUN_STATUS_VALUES,
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from '../src/execution-acceptance.js';
import { migrateDatabase } from '../src/migrations.js';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../src/outbox.js';
import { checkDatabaseReadiness } from '../src/readiness.js';
import {
  idempotencyRecords,
  outboxEvents,
  runCheckpoints,
  runEvents,
  workflowRuns,
} from '../src/schema.js';
import {
  STORED_EXECUTION_VALUE_LIMITS_V1,
  StoredExecutionValueInvalidError,
} from '../src/stored-execution-value.js';

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const dispatcherUrl =
  process.env.DATABASE_DISPATCHER_URL ??
  'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo';

const workspaceA = randomUUID();
const workspaceB = randomUUID();
const workflowId = randomUUID();
const workflowVersionId = randomUUID();
const keyHash = createHash('sha256').update('acceptance-key').digest('hex');
const requestHash = createHash('sha256').update('request-a').digest('hex');
const otherRequestHash = createHash('sha256').update('request-b').digest('hex');
const workspaceCreatorId = randomUUID();

const apiDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
);
const workerDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: workerUrl, max: 2 }),
);
const dispatcherDatabase = createOutboxDispatcherDatabase(
  parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 }),
);

const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
  maintenanceRole: 'pertexo_maintenance',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

function hasPostgresCode(expectedCode: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current = error;
    while (current instanceof Error) {
      if ('code' in current && current.code === expectedCode) return true;
      current = current.cause;
    }
    return false;
  };
}

function acceptanceInput(
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

function initialCheckpoint() {
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

async function expectAcceptanceRecordCounts(expected: number): Promise<void> {
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
    await client.query(
      `insert into app.workspaces (id, name, slug, status, created_by)
       values
         ($1, 'Execution A', $3, 'active', $5),
         ($2, 'Execution B', $4, 'active', $5)
       on conflict (id) do update set
         status = 'active',
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

async function createNotificationFixture(
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

async function insertDirectPinnedRun(
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

async function setFixtureStatus(
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

async function setNotificationPolicy(destinationId: string): Promise<void> {
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

describe('atomic workflow run acceptance', () => {
  it('accepts and replays a run under the worker role', async () => {
    const first = await workerDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptWorkflowRun(transaction, acceptanceInput()),
    );
    const replay = await workerDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptWorkflowRun(transaction, acceptanceInput()),
    );

    expect(first.duplicate).toBe(false);
    expect(replay).toEqual({ ...first, duplicate: true });
    await expectAcceptanceRecordCounts(1);
  });

  it('rejects malformed destination pins and inactive acceptance identities atomically', async () => {
    const valid = await createNotificationFixture();
    const unrelated = await createNotificationFixture();
    const wrongProvider = await createNotificationFixture({
      connectionKind: 'slack',
      destinationKind: 'email',
    });
    const validPin = {
      destinationId: valid.destinationId,
      secretVersionId: valid.secretVersionId,
      sideEffectClass: 'idempotent_with_key' as const,
    };
    const expectRejected = async (
      operation: () => Promise<void>,
    ): Promise<void> => {
      await expect(operation()).rejects.toSatisfy(hasPostgresCode('23514'));
      await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
        expect(await db.select({ count: count() }).from(workflowRuns)).toEqual([
          { count: 0 },
        ]);
      });
    };

    await expectRejected(() =>
      insertDirectPinnedRun({ ...validPin, sideEffectClass: 'unsafe' }),
    );
    await expectRejected(() =>
      insertDirectPinnedRun({
        ...validPin,
        secretVersionId: unrelated.secretVersionId,
      }),
    );
    await expectRejected(() =>
      insertDirectPinnedRun({
        ...validPin,
        destinationId: wrongProvider.destinationId,
        secretVersionId: wrongProvider.secretVersionId,
      }),
    );

    for (const [table, id, status] of [
      ['failure_notification_destinations', valid.destinationId, 'disabled'],
      ['connections', valid.connectionId, 'revoked'],
    ] as const) {
      await setFixtureStatus(table, id, status);
      await expectRejected(() => insertDirectPinnedRun(validPin));
      await setFixtureStatus(
        table,
        id,
        table === 'failure_notification_destinations' ? 'enabled' : 'active',
      );
    }
    await setFixtureStatus('workspaces', workspaceA, 'suspended');
    await expect(insertDirectPinnedRun(validPin)).rejects.toSatisfy(
      hasPostgresCode('PTA01'),
    );
    await setFixtureStatus('workspaces', workspaceA, 'active');

    await expect(
      apiDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
          insert into app.failure_notification_destination_versions
            (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
          values (${workspaceA},${randomUUID()},1,'email','idempotent_with_key',
            ${JSON.stringify({ connectionId: 'malformed', toEmail: 'pin@example.test' })}::jsonb,
            ${workspaceCreatorId})
        `),
      ),
    ).rejects.toSatisfy(hasPostgresCode('23514'));
  });

  it('serializes destination disable before acceptance and persists no stale pin', async () => {
    const fixture = await createNotificationFixture();
    await setNotificationPolicy(fixture.destinationId);
    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    const disabling = await pool.connect();
    try {
      await disabling.query('begin');
      await disabling.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await disabling.query(
        `update app.failure_notification_destinations set status='disabled'
          where workspace_id=$1 and id=$2`,
        [workspaceA, fixture.destinationId],
      );
      const acceptance = apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      );
      await expect(
        Promise.race([
          acceptance.then(() => 'settled'),
          new Promise<'waiting'>((resolve) => {
            setTimeout(() => {
              resolve('waiting');
            }, 50);
          }),
        ]),
      ).resolves.toBe('waiting');
      await disabling.query('commit');
      const accepted = await acceptance;
      const pin = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute<{ destination_id: string | null }>(sql`
          select failure_notification_destination_id destination_id
            from app.workflow_runs where id=${accepted.runId}
        `),
      );
      expect(pin.rows[0]).toEqual({ destination_id: null });
    } finally {
      await disabling.query('rollback').catch(() => undefined);
      disabling.release();
      await pool.end();
    }
  });

  it('serializes credential rotation before acceptance and pins the new current secret', async () => {
    const fixture = await createNotificationFixture();
    await setNotificationPolicy(fixture.destinationId);
    const nextSecretVersionId = randomUUID();
    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    const rotating = await pool.connect();
    try {
      await rotating.query('begin');
      await rotating.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await rotating.query(
        `insert into app.connection_secret_versions (
           id,workspace_id,connection_id,schema_version,kms_key_reference,
           encrypted_data_key,ciphertext,nonce,auth_tag,created_by
         ) values ($1,$2,$3,1,'kms','new-key','new-cipher','BBBBBBBBBBBBBBBB',
           'BBBBBBBBBBBBBBBBBBBBBB',$4)`,
        [
          nextSecretVersionId,
          workspaceA,
          fixture.connectionId,
          workspaceCreatorId,
        ],
      );
      await rotating.query(
        `update app.connections set current_secret_version_id=$3
          where workspace_id=$1 and id=$2`,
        [workspaceA, fixture.connectionId, nextSecretVersionId],
      );
      const acceptance = apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      );
      await expect(
        Promise.race([
          acceptance.then(() => 'settled'),
          new Promise<'waiting'>((resolve) => {
            setTimeout(() => {
              resolve('waiting');
            }, 50);
          }),
        ]),
      ).resolves.toBe('waiting');
      await rotating.query('commit');
      const accepted = await acceptance;
      const pin = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute<{ secret_version_id: string | null }>(sql`
          select failure_notification_connection_secret_version_id secret_version_id
            from app.workflow_runs where id=${accepted.runId}
        `),
      );
      expect(pin.rows[0]).toEqual({ secret_version_id: nextSecretVersionId });
    } finally {
      await rotating.query('rollback').catch(() => undefined);
      rotating.release();
      await pool.end();
    }
  });

  it('pins a manual-run destination once and replays after config, status, and credential changes', async () => {
    const connectionId = randomUUID();
    const secretVersionId = randomUUID();
    const destinationId = randomUUID();
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    const client = await owner.connect();
    const protectedTables = [
      'workflows',
      'connections',
      'connection_secret_versions',
      'failure_notification_destinations',
      'failure_notification_destination_versions',
      'workflow_failure_notification_policies',
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
         values ($1,$2,'Manual notification acceptance',$3)`,
        [workflowId, workspaceA, workspaceCreatorId],
      );
      await client.query(
        `insert into app.connections (
           id,workspace_id,provider_key,name,auth_type,status,
           current_secret_version_id,created_by
         ) values ($1,$2,'email','Manual notification email',
           'resend_api_key','active',$3,$4)`,
        [connectionId, workspaceA, secretVersionId, workspaceCreatorId],
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
         values ($1,$2,'email','enabled',1,$3)`,
        [destinationId, workspaceA, workspaceCreatorId],
      );
      await client.query(
        `insert into app.failure_notification_destination_versions
           (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
         values ($1,$2,1,'email','idempotent_with_key',$3::jsonb,$4)`,
        [
          workspaceA,
          destinationId,
          JSON.stringify({ connectionId, toEmail: 'manual@example.test' }),
          workspaceCreatorId,
        ],
      );
      await client.query(
        `insert into app.workflow_failure_notification_policies
           (workspace_id,workflow_id,destination_id,updated_by)
         values ($1,$2,$3,$4)`,
        [workspaceA, workflowId, destinationId, workspaceCreatorId],
      );
      await client.query('set constraints all immediate');
      for (const table of protectedTables)
        await client.query(`alter table app.${table} force row level security`);
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await owner.end();
    }

    const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, acceptanceInput()),
    );
    const nextSecretVersionId = randomUUID();
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      await db.execute(sql`
        insert into app.failure_notification_destination_versions
          (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
        values (${workspaceA},${destinationId},2,'email','idempotent_with_key',
          ${JSON.stringify({ connectionId, toEmail: 'changed@example.test' })}::jsonb,
          ${workspaceCreatorId})
      `);
      await db.execute(sql`
        update app.failure_notification_destinations
           set current_config_version=2,status='disabled'
         where workspace_id=${workspaceA} and id=${destinationId}
      `);
      await db.execute(sql`
        insert into app.connection_secret_versions (
          id,workspace_id,connection_id,schema_version,kms_key_reference,
          encrypted_data_key,ciphertext,nonce,auth_tag,created_by
        ) values (${nextSecretVersionId},${workspaceA},${connectionId},1,
          'kms','key2','cipher2','BBBBBBBBBBBBBBBB',
          'BBBBBBBBBBBBBBBBBBBBBB',${workspaceCreatorId})
      `);
      await db.execute(sql`
        update app.connections set current_secret_version_id=${nextSecretVersionId}
         where workspace_id=${workspaceA} and id=${connectionId}
      `);
    });

    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      ),
    ).resolves.toEqual({ ...first, duplicate: true });
    const pins = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute<{
        destination_config_version: number | null;
        destination_id: string | null;
        secret_version_id: string | null;
      }>(sql`
        select failure_notification_destination_id destination_id,
               failure_notification_destination_config_version destination_config_version,
               failure_notification_connection_secret_version_id secret_version_id
          from app.workflow_runs where id=${first.runId}
      `),
    );
    expect(pins.rows[0]).toEqual({
      destination_id: destinationId,
      destination_config_version: 1,
      secret_version_id: secretVersionId,
    });

    const second = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, {
        ...acceptanceInput(
          createHash('sha256').update('request-2').digest('hex'),
        ),
        keyHash: createHash('sha256').update('acceptance-key-2').digest('hex'),
      }),
    );
    const secondPins = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute<{ destination_id: string | null }>(sql`
        select failure_notification_destination_id destination_id
          from app.workflow_runs where id=${second.runId}
      `),
    );
    expect(secondPins.rows[0]).toEqual({ destination_id: null });
  });

  it.each(['suspended', 'pending_deletion', 'deleted'] as const)(
    'rejects new runs while the workspace is %s without persisting acceptance state',
    async (status) => {
      const owner = new Pool({ connectionString: migrationUrl, max: 1 });
      const client = await owner.connect();
      try {
        await client.query('begin');
        await client.query('set local role pertexo_owner');
        if (status === 'deleted') {
          await client.query(
            `with job as (
               insert into app.workspace_purge_jobs
                 (id,workspace_id,command_id,actor_ref,reason,occurred_at,status,
                  control_sequence,control_record_hash,completed_at)
               values (gen_random_uuid(),$1,gen_random_uuid(),'fixture:purge',
                 'Completed purge fixture',now(),'completed',1,$2,now())
               returning id
             ) insert into app.workspace_purge_steps
                 (job_id,step_name,status,completed_at)
               select id,'tenant_rows','completed',now() from job`,
            [workspaceA, 'f'.repeat(64)],
          );
        }
        await client.query(
          `update app.workspaces
           set status = $2::varchar,
               deletion_requested_at = case when $2::text = 'suspended' then null else now() end,
               deletion_requested_by = case when $2::text = 'suspended' then null::uuid else $3::uuid end,
               deletion_reason = case when $2::text = 'suspended' then null::varchar else 'fixture deletion'::varchar end,
               purge_after = case when $2::text = 'suspended' then null else now() + interval '30 days' end
           where id = $1`,
          [workspaceA, status, workspaceCreatorId],
        );
        await client.query('commit');
      } catch (error: unknown) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
        await owner.end();
      }

      await expect(
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, acceptanceInput()),
        ),
      ).rejects.toBeInstanceOf(WorkspaceRunAdmissionDeniedError);
      await expectAcceptanceRecordCounts(0);
    },
  );

  it('fails closed when the workspace lifecycle row does not exist', async () => {
    await expect(
      apiDatabase.withWorkspace(randomUUID(), (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      ),
    ).rejects.toBeInstanceOf(WorkspaceRunAdmissionDeniedError);
    await expectAcceptanceRecordCounts(0);
  });

  it('waits for an in-flight deletion and rejects after deletion wins the row lock', async () => {
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    const deletion = await owner.connect();
    try {
      await deletion.query('begin');
      await deletion.query('set local role pertexo_owner');
      await deletion.query(
        `update app.workspaces
         set status = 'pending_deletion',
             deletion_requested_at = now(),
             deletion_requested_by = $2,
             deletion_reason = 'concurrent deletion',
             purge_after = now() + interval '30 days'
         where id = $1`,
        [workspaceA, workspaceCreatorId],
      );

      const admission = apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      );
      const stateBeforeCommit = await Promise.race([
        admission.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<'waiting'>((resolve) => {
          setTimeout(() => {
            resolve('waiting');
          }, 50);
        }),
      ]);
      expect(stateBeforeCommit).toBe('waiting');

      await deletion.query('commit');
      await expect(admission).rejects.toBeInstanceOf(
        WorkspaceRunAdmissionDeniedError,
      );
      await expectAcceptanceRecordCounts(0);
    } catch (error: unknown) {
      await deletion.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      deletion.release();
      await owner.end();
    }
  });

  it('lets an admitted run commit before a racing deletion takes effect', async () => {
    let releaseAdmission!: () => void;
    const holdAdmission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let acceptanceLocked!: () => void;
    const admissionLocked = new Promise<void>((resolve) => {
      acceptanceLocked = resolve;
    });

    const admission = apiDatabase.withWorkspace(
      workspaceA,
      async (transaction) => {
        const accepted = await acceptWorkflowRun(
          transaction,
          acceptanceInput(),
        );
        acceptanceLocked();
        await holdAdmission;
        return accepted;
      },
    );
    await admissionLocked;

    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    const deletionClient = await owner.connect();
    await deletionClient.query('begin');
    await deletionClient.query('set local role pertexo_owner');
    const deletion = deletionClient.query(
      `update app.workspaces
       set status = 'pending_deletion',
           deletion_requested_at = now(),
           deletion_requested_by = $2,
           deletion_reason = 'concurrent deletion',
           purge_after = now() + interval '30 days'
       where id = $1
       returning status`,
      [workspaceA, workspaceCreatorId],
    );
    try {
      const stateBeforeAdmissionCommit = await Promise.race([
        deletion.then(() => 'settled'),
        new Promise<'waiting'>((resolve) => {
          setTimeout(() => {
            resolve('waiting');
          }, 50);
        }),
      ]);
      expect(stateBeforeAdmissionCommit).toBe('waiting');

      releaseAdmission();
      const accepted = await admission;
      expect(accepted).toMatchObject({
        duplicate: false,
        status: 'queued',
      });
      await expect(deletion).resolves.toMatchObject({
        rows: [{ status: 'pending_deletion' }],
      });
      await deletionClient.query('commit');
      await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
        await expect(
          db
            .select({ status: workflowRuns.status })
            .from(workflowRuns)
            .where(eq(workflowRuns.id, accepted.runId)),
        ).resolves.toEqual([{ status: 'canceled' }]);
        await expect(
          db
            .select({ type: runEvents.type })
            .from(runEvents)
            .where(eq(runEvents.workflowRunId, accepted.runId))
            .orderBy(runEvents.sequence),
        ).resolves.toEqual([
          { type: 'run.queued' },
          { type: 'run.cancel_requested' },
          { type: 'run.canceled' },
        ]);
      });
    } finally {
      releaseAdmission();
      await Promise.allSettled([admission, deletion]);
      await deletionClient.query('rollback').catch(() => undefined);
      deletionClient.release();
      await owner.end();
    }
  });

  it('commits one queued run, accepted event, revision-0 checkpoint, idempotency claim, and coordinator outbox', async () => {
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptWorkflowRun(transaction, acceptanceInput()),
    );

    expect(accepted).toMatchObject({ duplicate: false, status: 'queued' });
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      expect(
        await db
          .select({ status: idempotencyRecords.status })
          .from(idempotencyRecords)
          .where(eq(idempotencyRecords.resourceId, accepted.runId)),
      ).toEqual([{ status: 'completed' }]);
      expect(
        await db
          .select({ status: workflowRuns.status })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, accepted.runId)),
      ).toEqual([{ status: 'queued' }]);
      expect(
        await db
          .select({ sequence: runEvents.sequence, type: runEvents.type })
          .from(runEvents)
          .where(eq(runEvents.workflowRunId, accepted.runId)),
      ).toEqual([{ sequence: 1, type: 'run.queued' }]);
      expect(
        await db
          .select({ revision: runCheckpoints.revision })
          .from(runCheckpoints)
          .where(eq(runCheckpoints.workflowRunId, accepted.runId)),
      ).toEqual([{ revision: 0 }]);
      expect(
        await db
          .select({
            aggregateId: outboxEvents.aggregateId,
            jobName: outboxEvents.jobName,
            payload: outboxEvents.payload,
          })
          .from(outboxEvents)
          .where(eq(outboxEvents.aggregateId, accepted.runId)),
      ).toEqual([
        {
          aggregateId: accepted.runId,
          jobName: 'advance-workflow-run',
          payload: {
            outboxEventId: accepted.outboxEventId,
            runId: accepted.runId,
            schemaVersion: 1,
            workspaceId: workspaceA,
          },
        },
      ]);
    });
  });

  it('persists the caller-supplied initial checkpoint with the acceptance event cursor', async () => {
    const checkpoint = initialCheckpoint();
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) =>
        acceptWorkflowRun(transaction, {
          ...acceptanceInput(),
          initialCheckpoint: checkpoint,
        }),
    );

    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      expect(
        await db
          .select({ schedulerState: runCheckpoints.schedulerState })
          .from(runCheckpoints)
          .where(eq(runCheckpoints.workflowRunId, accepted.runId)),
      ).toEqual([{ schedulerState: checkpoint }]);
    });

    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, {
          ...acceptanceInput(),
          initialCheckpoint: checkpoint,
        }),
      ),
    ).resolves.toMatchObject({ duplicate: true, runId: accepted.runId });
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, {
          ...acceptanceInput(),
          initialCheckpoint: {
            ...checkpoint,
            remainingIterationBudget: 1,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
  });

  it('rejects an invalid initial checkpoint before persisting acceptance state', async () => {
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, {
          ...acceptanceInput(),
          initialCheckpoint: {
            ...initialCheckpoint(),
            nextEventSequence: 1,
          },
        }),
      ),
    ).rejects.toMatchObject({ name: 'Phase3CheckpointInvalidError' });
    await expectAcceptanceRecordCounts(0);
  });

  it('atomically stores a tagged inline run input at the exact application byte limit', async () => {
    const runInput = 'x'.repeat(
      STORED_EXECUTION_VALUE_LIMITS_V1.inlineBytes - 2,
    );
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput(requestHash, runInput)),
    );

    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      await expect(
        db
          .select({
            inputRef: workflowRuns.inputRef,
            inputRefExpiresAt: workflowRuns.inputRefExpiresAt,
          })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, accepted.runId)),
      ).resolves.toEqual([
        {
          inputRef: { schemaVersion: 1, kind: 'inline', value: runInput },
          inputRefExpiresAt: new Date(
            accepted.acceptedAt.getTime() + 30 * 24 * 60 * 60 * 1_000,
          ),
        },
      ]);
    });
  });

  it('persists canonical input without inherited toJSON hooks', async () => {
    const objectDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'toJSON',
    );
    const arrayDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      'toJSON',
    );
    let inputHookCalls = 0;
    try {
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true,
        value: function (this: unknown): unknown {
          if (
            typeof this === 'object' &&
            this !== null &&
            Object.hasOwn(this, 'kind') &&
            Object.hasOwn(this, 'schemaVersion')
          )
            inputHookCalls += 1;
          return this;
        },
      });
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        value: function (this: unknown): unknown {
          inputHookCalls += 1;
          return this;
        },
      });
      const accepted = await apiDatabase.withWorkspace(
        workspaceA,
        (transaction) =>
          acceptWorkflowRun(
            transaction,
            acceptanceInput(requestHash, { nested: [1, 2, 3] }),
          ),
      );
      await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
        await expect(
          db
            .select({ inputRef: workflowRuns.inputRef })
            .from(workflowRuns)
            .where(eq(workflowRuns.id, accepted.runId)),
        ).resolves.toEqual([
          {
            inputRef: {
              schemaVersion: 1,
              kind: 'inline',
              value: { nested: [1, 2, 3] },
            },
          },
        ]);
      });
      expect(inputHookCalls).toBe(0);
    } finally {
      if (objectDescriptor === undefined)
        Reflect.deleteProperty(Object.prototype, 'toJSON');
      else Object.defineProperty(Object.prototype, 'toJSON', objectDescriptor);
      if (arrayDescriptor === undefined)
        Reflect.deleteProperty(Array.prototype, 'toJSON');
      else Object.defineProperty(Array.prototype, 'toJSON', arrayDescriptor);
    }
  });

  it('rejects oversized or hostile run input before writing acceptance state', async () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return true;
      },
    });
    for (const runInput of [
      'x'.repeat(STORED_EXECUTION_VALUE_LIMITS_V1.inlineBytes - 1),
      hostile,
    ]) {
      await expect(
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(
            transaction,
            acceptanceInput(requestHash, runInput),
          ),
        ),
      ).rejects.toBeInstanceOf(StoredExecutionValueInvalidError);
      await expectAcceptanceRecordCounts(0);
    }
    expect(getterCalls).toBe(0);
  });

  it('keeps the first durable run input on an exact idempotent replay', async () => {
    const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(
        transaction,
        acceptanceInput(requestHash, { retained: true }),
      ),
    );
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(
          transaction,
          acceptanceInput(requestHash, { retained: false }),
        ),
      ),
    ).resolves.toEqual({ ...first, duplicate: true });
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      await expect(
        db
          .select({ inputRef: workflowRuns.inputRef })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, first.runId)),
      ).resolves.toEqual([
        {
          inputRef: {
            schemaVersion: 1,
            kind: 'inline',
            value: { retained: true },
          },
        },
      ]);
    });
  });

  it('returns the existing run for an exact retry and rejects a changed request hash', async () => {
    const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, acceptanceInput()),
    );
    const retry = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, acceptanceInput()),
    );

    expect(retry).toEqual({ ...first, duplicate: true });
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput(otherRequestHash)),
      ),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
    await expectAcceptanceRecordCounts(1);
  });

  it.each(['suspended', 'pending_deletion', 'deleted'] as const)(
    'returns durable accepted truth for an exact retry after the workspace becomes %s',
    async (status) => {
      const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      );
      const owner = new Pool({ connectionString: migrationUrl, max: 1 });
      try {
        await owner.query('set role pertexo_owner');
        if (status === 'deleted') {
          await owner.query(
            `with job as (
               insert into app.workspace_purge_jobs
                 (id,workspace_id,command_id,actor_ref,reason,occurred_at,status,
                  control_sequence,control_record_hash,completed_at)
               values (gen_random_uuid(),$1,gen_random_uuid(),'fixture:purge',
                 'Completed purge fixture',now(),'completed',1,$2,now())
               returning id
             ) insert into app.workspace_purge_steps
                 (job_id,step_name,status,completed_at)
               select id,'tenant_rows','completed',now() from job`,
            [workspaceA, 'f'.repeat(64)],
          );
        }
        await owner.query(
          `update app.workspaces
           set status = $2::varchar,
               deletion_requested_at = case when $2::text = 'suspended' then null else now() end,
               deletion_requested_by = case when $2::text = 'suspended' then null::uuid else $3::uuid end,
               deletion_reason = case when $2::text = 'suspended' then null::varchar else 'fixture deletion'::varchar end,
               purge_after = case when $2::text = 'suspended' then null else now() + interval '30 days' end
           where id = $1`,
          [workspaceA, status, workspaceCreatorId],
        );
      } finally {
        await owner.end();
      }

      const replay = await apiDatabase.withWorkspace(
        workspaceA,
        (transaction) => acceptWorkflowRun(transaction, acceptanceInput()),
      );
      expect(replay).toEqual(
        status === 'pending_deletion'
          ? { ...first, duplicate: true, status: 'canceled' }
          : { ...first, duplicate: true },
      );
      await expect(
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, acceptanceInput(otherRequestHash)),
        ),
      ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
      if (status !== 'pending_deletion') await expectAcceptanceRecordCounts(1);
    },
  );

  it('rolls the entire acceptance back when its surrounding transaction fails', async () => {
    await expect(
      apiDatabase.withWorkspace(workspaceA, async (transaction) => {
        await acceptWorkflowRun(transaction, acceptanceInput());
        throw new Error('injected post-acceptance failure');
      }),
    ).rejects.toThrow('injected post-acceptance failure');

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
          { count: 0 },
        ]);
      }
    });
  });

  it('serializes concurrent exact retries to one accepted run', async () => {
    const [left, right] = await Promise.all([
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      ),
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      ),
    ]);

    expect(left.runId).toBe(right.runId);
    expect([left.duplicate, right.duplicate].sort()).toEqual([false, true]);
    await expectAcceptanceRecordCounts(1);
  });

  it('atomically admits exactly one hundred of one hundred and one concurrent queued runs', async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 101 }, (_, index) =>
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, {
            ...acceptanceInput(
              createHash('sha256')
                .update(`request-${String(index)}`)
                .digest('hex'),
            ),
            keyHash: createHash('sha256')
              .update(`key-${String(index)}`)
              .digest('hex'),
            scope: `quota:${String(index)}`,
          }),
        ),
      ),
    );
    expect(
      outcomes.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(100);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(WorkspaceRunQuotaExceededError);
    await expectAcceptanceRecordCounts(100);

    const admitted = outcomes.find(
      (
        outcome,
      ): outcome is PromiseFulfilledResult<
        Awaited<ReturnType<typeof acceptWorkflowRun>>
      > => outcome.status === 'fulfilled',
    );
    if (admitted === undefined) throw new Error('Expected an admitted run');
    await workerDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute(sql`
        update app.workflow_runs set status='running'
         where workspace_id=${workspaceA} and id=${admitted.value.runId}
      `),
    );
    await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, {
        ...acceptanceInput(
          createHash('sha256').update('replacement-request').digest('hex'),
        ),
        keyHash: createHash('sha256').update('replacement-key').digest('hex'),
        scope: 'quota:replacement',
      }),
    );
    await expect(
      workerDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
          update app.workflow_runs set status='queued'
           where workspace_id=${workspaceA} and id=${admitted.value.runId}
        `),
      ),
    ).rejects.toSatisfy(hasPostgresCode('PTA02'));
  });

  it('reserves active capacity before coordinator outbox work reaches BullMQ', async () => {
    const accepted = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, {
            ...acceptanceInput(
              createHash('sha256')
                .update(`dispatch-request-${String(index)}`)
                .digest('hex'),
            ),
            keyHash: createHash('sha256')
              .update(`dispatch-key-${String(index)}`)
              .digest('hex'),
            scope: `dispatch:${String(index)}`,
          }),
        ),
      ),
    );
    const claim = () =>
      dispatcherDatabase.claimBatch({
        enabledJobNames: ['advance-workflow-run'],
        leaseDurationMillis: 30_000,
        leaseOwner: 'active-admission-test',
        leaseToken: randomUUID(),
        limit: 1,
        maxAttempts: 3,
      });
    const admittedEventIds: string[] = [];
    const admittedRunIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const batch = await claim();
      const event = batch.events[0];
      if (event === undefined)
        throw new Error(`Expected admitted outbox work ${String(index + 1)}`);
      admittedEventIds.push(event.id);
      admittedRunIds.push(event.aggregateId);
      await expect(
        dispatcherDatabase.markPublished(event.id, event.leaseToken),
      ).resolves.toBe(true);
    }
    await expect(claim()).resolves.toMatchObject({ events: [] });

    const otherEventId = randomUUID();
    const otherPayload = {
      schemaVersion: 1,
      workspaceId: workspaceB,
      outboxEventId: otherEventId,
    } as const;
    await apiDatabase.withWorkspace(workspaceB, (transaction) =>
      insertOutboxEvent(transaction, {
        id: otherEventId,
        jobName: 'phase0-duplicate-proof',
        schemaVersion: 1,
        aggregateType: 'fairness-probe',
        aggregateId: randomUUID(),
        payload: otherPayload,
        payloadChecksum: canonicalOutboxPayloadChecksum(otherPayload),
        availableAt: new Date(0),
      }),
    );
    const cursorOwner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await cursorOwner.query('begin');
      await cursorOwner.query('set local role pertexo_owner');
      await cursorOwner.query(
        `update app.outbox_fair_dispatch_cursor set last_workspace_id=$1`,
        [workspaceB],
      );
      await cursorOwner.query('commit');
    } finally {
      await cursorOwner.query('rollback').catch(() => undefined);
      await cursorOwner.end();
    }
    const mixedClaim = () =>
      dispatcherDatabase.claimBatch({
        enabledJobNames: ['advance-workflow-run', 'phase0-duplicate-proof'],
        leaseDurationMillis: 30_000,
        leaseOwner: 'saturated-window-test',
        leaseToken: randomUUID(),
        limit: 1,
        maxAttempts: 3,
      });
    await expect(mixedClaim()).resolves.toMatchObject({ events: [] });
    const afterSaturatedWindow = await mixedClaim();
    expect(afterSaturatedWindow.events[0]?.id).toBe(otherEventId);
    const otherEvent = afterSaturatedWindow.events[0];
    if (otherEvent === undefined)
      throw new Error('Expected fair probe delivery');
    await dispatcherDatabase.markPublished(
      otherEvent.id,
      otherEvent.leaseToken,
    );

    const firstEventId = admittedEventIds[0];
    if (firstEventId === undefined)
      throw new Error('Expected admitted outbox identity');
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query(
        `update app.workflow_run_active_admissions
            set recover_after='-infinity'::timestamptz
          where outbox_event_id=$1`,
        [firstEventId],
      );
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }
    const recovered = await claim();
    expect(recovered.events[0]?.id).not.toBe(firstEventId);
    expect(recovered.events[0]?.aggregateId).toBe(admittedRunIds[0]);
    expect(recovered.events[0]?.payloadChecksum).toBe(
      canonicalOutboxPayloadChecksum(recovered.events[0]?.payload),
    );
    const recoveredEvent = recovered.events[0];
    if (recoveredEvent === undefined)
      throw new Error('Expected recovered coordinator delivery');
    await expect(
      dispatcherDatabase.markPublished(
        recoveredEvent.id,
        recoveredEvent.leaseToken,
      ),
    ).resolves.toBe(true);

    const firstRunId = admittedRunIds[0];
    if (firstRunId === undefined)
      throw new Error('Expected admitted run identity');
    await workerDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute(sql`
        update app.workflow_runs set status='running'
         where workspace_id=${workspaceA} and id=${firstRunId}
      `),
    );
    await workerDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute(sql`
        update app.workflow_runs set status='succeeded'
         where workspace_id=${workspaceA} and id=${firstRunId}
      `),
    );
    const released = await claim();
    expect(released.events).toHaveLength(1);
    expect(
      accepted.some(({ runId }) => runId === released.events[0]?.aggregateId),
    ).toBe(true);
  });

  it('resolves an exact replay before a later entitlement suspension', async () => {
    const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, acceptanceInput()),
    );
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await owner.query(
        `insert into app.workspace_execution_entitlement_versions
           (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
         values ($1,2,'suspended',5,100,'-infinity'::timestamptz)`,
        [workspaceA],
      );
      await owner.query(
        `update app.workspace_execution_entitlements set current_version=2
          where workspace_id=$1`,
        [workspaceA],
      );
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }

    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      ),
    ).resolves.toEqual({ ...first, duplicate: true });
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, {
          ...acceptanceInput(otherRequestHash),
          keyHash: createHash('sha256').update('new-key').digest('hex'),
          scope: 'new-after-suspension',
        }),
      ),
    ).rejects.toBeInstanceOf(WorkspaceRunAdmissionDeniedError);
    await expectAcceptanceRecordCounts(1);
  });

  it('lets an accepted run acquire and release its pinned slot after entitlement expiry', async () => {
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await owner.query(
        `insert into app.workspace_execution_entitlement_versions
           (workspace_id,version,status,active_run_limit,queued_run_limit,
            effective_at,expires_at)
         values ($1,9,'active',5,100,'-infinity'::timestamptz,
                 clock_timestamp()+interval '1 second')`,
        [workspaceA],
      );
      await owner.query(
        `update app.workspace_execution_entitlements set current_version=9
          where workspace_id=$1`,
        [workspaceA],
      );
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptWorkflowRun(transaction, acceptanceInput()),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(
      workerDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
          update app.workflow_runs set status='running'
           where workspace_id=${workspaceA} and id=${accepted.runId}
        `),
      ),
    ).resolves.toBeDefined();
    await expect(
      workerDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
          update app.workflow_runs set status='succeeded'
           where workspace_id=${workspaceA} and id=${accepted.runId}
        `),
      ),
    ).resolves.toBeDefined();
    const counters = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute<{ active_runs: number; queued_runs: number }>(sql`
        select active_runs,queued_runs
          from app.workspace_execution_admission_counters
      `),
    );
    expect(counters.rows).toEqual([{ active_runs: 0, queued_runs: 0 }]);
  });

  it('enforces five active runs while waiting retains and terminal state releases the slot', async () => {
    const accepted = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, {
            ...acceptanceInput(
              createHash('sha256')
                .update(`active-request-${String(index)}`)
                .digest('hex'),
            ),
            keyHash: createHash('sha256')
              .update(`active-key-${String(index)}`)
              .digest('hex'),
            scope: `active:${String(index)}`,
          }),
        ),
      ),
    );
    const starts = await Promise.allSettled(
      accepted.map(({ runId }) =>
        workerDatabase.withWorkspace(workspaceA, ({ db }) =>
          db.execute(sql`
            update app.workflow_runs set status='running'
             where workspace_id=${workspaceA} and id=${runId} and status='queued'
          `),
        ),
      ),
    );
    expect(starts.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      5,
    );
    expect(
      starts.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === 'rejected',
      )?.reason,
    ).toSatisfy(hasPostgresCode('PTA03'));

    const statuses = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute<{ id: string; status: string }>(sql`
        select id,status from app.workflow_runs order by id
      `),
    );
    const running = statuses.rows.filter(({ status }) => status === 'running');
    const queued = statuses.rows.find(({ status }) => status === 'queued');
    expect(running).toHaveLength(5);
    expect(queued).toBeDefined();
    const waitingId = running[0]?.id;
    if (waitingId === undefined || queued === undefined)
      throw new Error('Active admission fixture is incomplete');
    await workerDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute(
        sql`update app.workflow_runs set status='waiting' where id=${waitingId}`,
      ),
    );
    await expect(
      workerDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(
          sql`update app.workflow_runs set status='running' where id=${queued.id}`,
        ),
      ),
    ).rejects.toSatisfy(hasPostgresCode('PTA03'));
    await workerDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute(
        sql`update app.workflow_runs set status='succeeded' where id=${waitingId}`,
      ),
    );
    await expect(
      workerDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(
          sql`update app.workflow_runs set status='running' where id=${queued.id}`,
        ),
      ),
    ).resolves.toBeDefined();
    const counters = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute<{ active_runs: number; queued_runs: number }>(sql`
        select active_runs,queued_runs
          from app.workspace_execution_admission_counters
      `),
    );
    expect(counters.rows).toEqual([{ active_runs: 5, queued_runs: 0 }]);
  });

  it('repairs admission counters from authoritative run state', async () => {
    await Promise.all(
      [0, 1].map((index) =>
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, {
            ...acceptanceInput(
              createHash('sha256')
                .update(`repair-${String(index)}`)
                .digest('hex'),
            ),
            keyHash: createHash('sha256')
              .update(`repair-key-${String(index)}`)
              .digest('hex'),
            scope: `repair:${String(index)}`,
          }),
        ),
      ),
    );
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await owner.query(
        `update app.workspace_execution_admission_counters
            set queued_runs=99,active_runs=99 where workspace_id=$1`,
        [workspaceA],
      );
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }
    const repaired = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute<{ active_runs: number; queued_runs: number }>(sql`
        select * from app.reconcile_workspace_execution_admission(${workspaceA})
      `),
    );
    expect(repaired.rows).toEqual([{ queued_runs: 2, active_runs: 0 }]);
  });

  it('hides all accepted state across workspaces and rejects a forged workspace insert', async () => {
    await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, acceptanceInput()),
    );

    await expect(
      apiDatabase.withWorkspace(workspaceB, async ({ db }) => {
        const tables = [
          idempotencyRecords,
          workflowRuns,
          runEvents,
          runCheckpoints,
          outboxEvents,
        ] as const;
        for (const table of tables) {
          expect(await db.select({ count: count() }).from(table)).toEqual([
            { count: 0 },
          ]);
        }
        await db.insert(workflowRuns).values({
          id: randomUUID(),
          workspaceId: workspaceA,
          workflowId,
          workflowVersionId,
          triggerType: 'manual',
          status: 'queued',
        });
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        hasPostgresCode('42501')(error) || hasPostgresCode('PTA01')(error),
    );
  });

  it('accepts canonical execution statuses and rejects legacy spellings', async () => {
    const runtime = new Pool({ connectionString: apiUrl, max: 1 });
    const client = await runtime.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.workspace_id', $1, true)`, [
        workspaceA,
      ]);

      for (const status of RUN_STATUS_VALUES) {
        await client.query(
          `
            insert into app.workflow_runs (
              id, workspace_id, workflow_id, workflow_version_id,
              trigger_type, status
            ) values ($1, $2, $3, $4, 'manual', $5)
          `,
          [randomUUID(), workspaceA, workflowId, workflowVersionId, status],
        );
      }

      await client.query('savepoint reject_legacy_run_status');
      await expect(
        client.query(
          `
            insert into app.workflow_runs (
              id, workspace_id, workflow_id, workflow_version_id,
              trigger_type, status
            ) values ($1, $2, $3, $4, 'manual', 'cancelled')
          `,
          [randomUUID(), workspaceA, workflowId, workflowVersionId],
        ),
      ).rejects.toSatisfy(hasPostgresCode('23514'));
      await client.query('rollback to savepoint reject_legacy_run_status');

      for (const status of IDEMPOTENCY_STATUS_VALUES) {
        await client.query(
          `
            insert into app.idempotency_records (
              id, workspace_id, operation, scope, key_hash, request_hash,
              status, resource_id, result_ref
            ) values ($1, $2, 'workflow.run.accept', $3, $4, $5, $6, $7, '{}')
          `,
          [
            randomUUID(),
            workspaceA,
            `status:${status}`,
            createHash('sha256').update(`key:${status}`).digest('hex'),
            createHash('sha256').update(`request:${status}`).digest('hex'),
            status,
            randomUUID(),
          ],
        );
      }

      await client.query('savepoint reject_legacy_idempotency_status');
      await expect(
        client.query(
          `
            insert into app.idempotency_records (
              id, workspace_id, operation, scope, key_hash, request_hash,
              status, resource_id, result_ref
            ) values ($1, $2, 'workflow.run.accept', 'legacy-status', $3, $4,
              'claimed', $5, '{}')
          `,
          [randomUUID(), workspaceA, keyHash, requestHash, randomUUID()],
        ),
      ).rejects.toSatisfy(hasPostgresCode('23514'));
      await client.query(
        'rollback to savepoint reject_legacy_idempotency_status',
      );
      await client.query('rollback');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await runtime.end();
    }
  });

  it('forces RLS and grants only the acceptance operations to runtime roles', async () => {
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      const security = await owner.query<{
        relforcerowsecurity: boolean;
        relrowsecurity: boolean;
        relname: string;
      }>(
        `
        select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app'
          and c.relname = any($1::text[])
        order by c.relname
      `,
        [
          [
            'idempotency_records',
            'run_checkpoints',
            'run_events',
            'workflow_runs',
          ],
        ],
      );
      expect(security.rows).toHaveLength(4);
      expect(
        security.rows.every(
          (row) => row.relrowsecurity && row.relforcerowsecurity,
        ),
      ).toBe(true);

      const privileges = await owner.query<{
        canDelete: boolean;
        canInsert: boolean;
        canSelect: boolean;
        canUpdate: boolean;
        roleName: string;
        tableName: string;
      }>(`
        with runtime_roles(role_name) as (
          values ('pertexo_api'), ('pertexo_dispatcher'), ('pertexo_worker')
        ), execution_tables(table_oid, table_name) as (
          select c.oid, c.relname
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'app'
            and c.relname = any(array[
              'idempotency_records',
              'run_checkpoints',
              'run_events',
              'workflow_runs'
            ])
        )
        select
          role_name as "roleName",
          table_name as "tableName",
          has_table_privilege(role_name, table_oid, 'SELECT') as "canSelect",
          has_table_privilege(role_name, table_oid, 'INSERT') as "canInsert",
          has_table_privilege(role_name, table_oid, 'UPDATE') as "canUpdate",
          has_table_privilege(role_name, table_oid, 'DELETE') as "canDelete"
        from runtime_roles
        cross join execution_tables
        order by role_name, table_name
      `);
      expect(privileges.rows).toHaveLength(12);
      for (const row of privileges.rows) {
        expect(row.canSelect).toBe(row.roleName !== 'pertexo_dispatcher');
        expect(row.canInsert).toBe(
          row.roleName === 'pertexo_api' || row.roleName === 'pertexo_worker',
        );
        expect(row.canUpdate).toBe(false);
        expect(row.canDelete).toBe(false);
      }

      const idempotencyUpdatePrivileges = await owner.query<{
        canUpdate: boolean;
        columnName: string;
        roleName: string;
      }>(`
        with runtime_roles(role_name) as (
          values ('pertexo_api'), ('pertexo_dispatcher'), ('pertexo_worker')
        ), idempotency_columns(column_name) as (
          values
            ('status'),
            ('result_ref'),
            ('updated_at'),
            ('request_hash'),
            ('resource_id')
        ), idempotency_relation(oid) as (
          select table_class.oid
          from pg_class table_class
          join pg_namespace table_namespace
            on table_namespace.oid = table_class.relnamespace
          where table_namespace.nspname = 'app'
            and table_class.relname = 'idempotency_records'
        )
        select
          role_name as "roleName",
          column_name as "columnName",
          has_column_privilege(
            role_name,
            idempotency_relation.oid,
            column_name,
            'UPDATE'
          ) as "canUpdate"
        from runtime_roles
        cross join idempotency_columns
        cross join idempotency_relation
        order by role_name, column_name
      `);
      expect(idempotencyUpdatePrivileges.rows).toHaveLength(15);
      for (const row of idempotencyUpdatePrivileges.rows) {
        expect(row.canUpdate).toBe(
          (row.roleName === 'pertexo_api' ||
            row.roleName === 'pertexo_worker') &&
            ['result_ref', 'status', 'updated_at'].includes(row.columnName),
        );
      }
    } finally {
      await owner.end();
    }
  });

  it('forces entitlement RLS and denies serving-role entitlement mutation', async () => {
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      const catalog = await owner.query<{
        relforcerowsecurity: boolean;
        relname: string;
        relrowsecurity: boolean;
      }>(`
        select relname,relrowsecurity,relforcerowsecurity
          from pg_class where oid=any(array[
            'app.workspace_execution_entitlement_versions'::regclass,
            'app.workspace_execution_entitlements'::regclass,
            'app.workspace_execution_admission_counters'::regclass
          ]) order by relname
      `);
      expect(catalog.rows).toHaveLength(3);
      expect(
        catalog.rows.every(
          ({ relrowsecurity, relforcerowsecurity }) =>
            relrowsecurity && relforcerowsecurity,
        ),
      ).toBe(true);
      const grants = await owner.query<{
        can_insert: boolean;
        can_select: boolean;
        can_update: boolean;
        role_name: string;
      }>(`
        with roles(role_name) as (
          values ('pertexo_api'),('pertexo_worker'),('pertexo_dispatcher')
        ) select role_name,
          has_table_privilege(role_name,'app.workspace_execution_entitlement_versions','SELECT') can_select,
          has_table_privilege(role_name,'app.workspace_execution_entitlement_versions','INSERT') can_insert,
          has_table_privilege(role_name,'app.workspace_execution_entitlement_versions','UPDATE') can_update
        from roles order by role_name
      `);
      expect(grants.rows).toEqual([
        {
          role_name: 'pertexo_api',
          can_select: true,
          can_insert: false,
          can_update: false,
        },
        {
          role_name: 'pertexo_dispatcher',
          can_select: false,
          can_insert: false,
          can_update: false,
        },
        {
          role_name: 'pertexo_worker',
          can_select: true,
          can_insert: false,
          can_update: false,
        },
      ]);
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }
    await expect(
      apiDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
          update app.workspace_execution_entitlement_versions
             set queued_run_limit=101 where workspace_id=${workspaceA} and version=1
        `),
      ),
    ).rejects.toSatisfy(hasPostgresCode('42501'));
  });

  it('fails readiness when an admission trigger is disabled', async () => {
    const readiness = new Pool({ connectionString: apiUrl, max: 1 });
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await expect(
        checkDatabaseReadiness(readiness, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toBeDefined();
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query(
        'alter table app.workflow_runs disable trigger workflow_runs_execution_admission',
      );
      await owner.query('commit');
      await expect(
        checkDatabaseReadiness(readiness, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).rejects.toThrow('Execution admission persistence is incompatible');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.query('begin').catch(() => undefined);
      await owner.query('set local role pertexo_owner').catch(() => undefined);
      await owner
        .query(
          'alter table app.workflow_runs enable trigger workflow_runs_execution_admission',
        )
        .catch(() => undefined);
      await owner.query('commit').catch(() => undefined);
      await Promise.all([owner.end(), readiness.end()]);
    }
  });
});
