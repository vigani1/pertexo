import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../src/migrations.js';
import {
  createWorkspaceLifecycleCommandCoordinator,
  type WorkspaceLifecycleLedgerRecord,
} from '../src/lifecycle/workspace-lifecycle-commands.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const lifecycleBaseUrl =
  process.env.DATABASE_LIFECYCLE_COMMAND_URL ??
  'postgresql://pertexo_lifecycle_command:pertexo-local-lifecycle-command@localhost:5432/pertexo';
const databaseName = `pertexo_test_lifecycle_intents_${randomUUID().replaceAll('-', '')}`;
const withDatabase = (baseUrl: string) => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};
const migrationUrl = withDatabase(migrationBaseUrl);
const apiUrl = withDatabase(apiBaseUrl);
const lifecycleUrl = withDatabase(lifecycleBaseUrl);
const workspaceId = randomUUID();
const ownerUserId = randomUUID();
const otherUserId = randomUUID();
const connectionId = randomUUID();
const connectionSecretId = randomUUID();
const queuedRunId = randomUUID();
const runningRunId = randomUUID();
const scheduleTriggerId = randomUUID();
const webhookTriggerId = randomUUID();
const workflowId = randomUUID();
const workflowVersionId = randomUUID();
let api: Pool | undefined;
let lifecycle: Pool | undefined;
let firstOperationId = '';

async function apiWorkspaceQuery(
  text: string,
  values: readonly unknown[],
  actorUserId = ownerUserId,
) {
  if (api === undefined) throw new Error('API pool unavailable');
  const client = await api.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await client.query("select set_config('app.actor_id',$1,true)", [
      actorUserId,
    ]);
    const result = await client.query(text, [...values]);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,
       pertexo_api,pertexo_worker,pertexo_dispatcher,pertexo_maintenance,
       pertexo_lifecycle_command`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase({
    apiRuntimeRole: 'pertexo_api',
    connectionString: migrationUrl,
    dispatcherRole: 'pertexo_dispatcher',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    operatorRole: 'pertexo_operator',
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  });
  const owner = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await owner.query('begin');
    await owner.query('set local role pertexo_owner');
    await owner.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await owner.query(
      `insert into app.users(id,email,display_name) values
       ($1,$2,'Owner'),($3,$4,'Other')`,
      [
        ownerUserId,
        `${ownerUserId}@example.test`,
        otherUserId,
        `${otherUserId}@example.test`,
      ],
    );
    await owner.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Intent fixture',$2,$3)",
      [workspaceId, `intent-${workspaceId}`, ownerUserId],
    );
    await owner.query(
      "insert into app.workspace_memberships(workspace_id,user_id,role) values($1,$2,'owner')",
      [workspaceId, ownerUserId],
    );
    await owner.query(
      `insert into app.sessions(id,user_id,token_digest,expires_at)
       values($1,$2,$3,clock_timestamp()+interval '1 day')`,
      [randomUUID(), ownerUserId, '7'.repeat(64)],
    );
    await owner.query(
      `insert into app.workflows(id,workspace_id,name,lifecycle_status,
         activation_status,published_version_id,created_by)
       values($1,$2,'Lifecycle fixture','active','inactive',null,$3)`,
      [workflowId, workspaceId, ownerUserId],
    );
    await owner.query(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,
         version_number,schema_version,graph_json,checksum,
         executable_schema_version,executable_json,compatibility_release_epoch,
         published_by)
       values($1,$2,$3,1,1,$4::jsonb,$5,2,'{}'::jsonb,1,$6)`,
      [
        workflowVersionId,
        workspaceId,
        workflowId,
        JSON.stringify({
          schemaVersion: 1,
          settings: {},
          nodes: [],
          edges: [],
        }),
        `wf:v2:sha256:${'a'.repeat(64)}`,
        ownerUserId,
      ],
    );
    await owner.query(
      "update app.workflows set published_version_id=$2,activation_status='active' where id=$1",
      [workflowId, workflowVersionId],
    );
    await owner.query(
      `insert into app.workflow_triggers(id,workspace_id,workflow_id,
         workflow_version_id,node_id,kind,status,health_status,desired_config,
         config_fingerprint)
       values($1,$2,$3,$4,'schedule','schedule','active','healthy',$5::jsonb,$6),
             ($7,$2,$3,$4,'webhook','webhook','active','healthy','{}'::jsonb,$8)`,
      [
        scheduleTriggerId,
        workspaceId,
        workflowId,
        workflowVersionId,
        JSON.stringify({ recurrence: 'interval' }),
        `trigger:v1:sha256:${'b'.repeat(64)}`,
        webhookTriggerId,
        `trigger:v1:sha256:${'c'.repeat(64)}`,
      ],
    );
    await owner.query(
      `insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,
         interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at,
         status,health_status,lease_owner,lease_token,lease_acquired_at,lease_expires_at)
       values($1,$2,'interval',5,'skip',$3,clock_timestamp(),
         clock_timestamp()+interval '5 minutes','enabled','healthy','scanner',$4,
         clock_timestamp(),clock_timestamp()+interval '1 minute')`,
      [
        scheduleTriggerId,
        workspaceId,
        `trigger:v1:sha256:${'b'.repeat(64)}`,
        randomUUID(),
      ],
    );
    await owner.query(
      `with connection as (
         insert into app.connections(id,workspace_id,provider_key,name,auth_type,
           status,current_secret_version_id,created_by)
         values($1,$2,'http','Lifecycle connection','http_headers','active',$3,$4)
         returning id
       ) insert into app.connection_secret_versions(id,workspace_id,connection_id,
         schema_version,kms_key_reference,encrypted_data_key,ciphertext,nonce,
         auth_tag,created_by)
       select $3,$2,id,1,'kms','key','cipher','AAAAAAAAAAAAAAAA',
         'AAAAAAAAAAAAAAAAAAAAAA',$4 from connection`,
      [connectionId, workspaceId, connectionSecretId, ownerUserId],
    );
    await owner.query('commit');
  } catch (error: unknown) {
    await owner.query('rollback');
    throw error;
  } finally {
    await owner.end();
  }
  api = new Pool({ connectionString: apiUrl, max: 2 });
  const queuedCheckpoint = {
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
  };
  const runningCheckpoint = {
    ...queuedCheckpoint,
    revision: 1,
    runStatus: 'running',
    nextEventSequence: 3,
  };
  await apiWorkspaceQuery(
    `insert into app.workflow_runs(id,workspace_id,workflow_id,
       workflow_version_id,trigger_type,status,started_at)
     values($1,$3,$4,$5,'manual','queued',null),
           ($2,$3,$4,$5,'manual','running',clock_timestamp())`,
    [queuedRunId, runningRunId, workspaceId, workflowId, workflowVersionId],
  );
  await apiWorkspaceQuery(
    `insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload)
     values($1,$2,1,'run.queued','{}'::jsonb),
           ($1,$3,1,'run.queued','{}'::jsonb),
           ($1,$3,2,'run.started','{}'::jsonb)`,
    [workspaceId, queuedRunId, runningRunId],
  );
  await apiWorkspaceQuery(
    `insert into app.run_checkpoints(workflow_run_id,workspace_id,revision,
       engine_version,scheduler_state,workflow_version_id)
     values($1,$3,0,'phase0-engine-v1',$4::jsonb,$6),
           ($2,$3,1,'phase0-engine-v1',$5::jsonb,$6)`,
    [
      queuedRunId,
      runningRunId,
      workspaceId,
      JSON.stringify(queuedCheckpoint),
      JSON.stringify(runningCheckpoint),
      workflowVersionId,
    ],
  );
  lifecycle = new Pool({ connectionString: lifecycleUrl, max: 2 });
}, 120_000);

afterAll(async () => {
  await Promise.all([api?.end(), lifecycle?.end()]);
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('workspace lifecycle command intents', () => {
  it('creates one exact durable operation without changing workspace state', async () => {
    if (api === undefined) throw new Error('API pool unavailable');
    const operationId = randomUUID();
    firstOperationId = operationId;
    const values = [
      operationId,
      workspaceId,
      'f'.repeat(64),
      'deletion_requested',
      ownerUserId,
      'Delete workspace',
      'a'.repeat(64),
    ];
    const first = await apiWorkspaceQuery(
      'select * from app.request_workspace_lifecycle_operation($1,$2,$3,$4,$5,$6,$7)',
      values,
    );
    const replay = await apiWorkspaceQuery(
      'select * from app.request_workspace_lifecycle_operation($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(), ...values.slice(1)],
    );

    expect(first.rows[0]).toMatchObject({
      command_type: 'deletion_requested',
      operation_id: operationId,
      status: 'pending',
      workspace_id: workspaceId,
    });
    expect(replay.rows[0]).toMatchObject({ operation_id: operationId });
    await expect(
      apiWorkspaceQuery(
        'select * from app.request_workspace_lifecycle_operation($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          workspaceId,
          'f'.repeat(64),
          'deletion_requested',
          ownerUserId,
          'Changed',
          'b'.repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      api.query('select * from app.workspace_lifecycle_operations'),
    ).rejects.toMatchObject({
      code: '42501',
    });
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('set role pertexo_owner');
      const state = await owner.query<{ status: string }>(
        'select status from app.workspaces where id=$1',
        [workspaceId],
      );
      expect(state.rows[0]?.status).toBe('active');
    } finally {
      await owner.end();
    }
  });

  it('rechecks owner authorization and exposes only narrow role functions', async () => {
    if (api === undefined || lifecycle === undefined)
      throw new Error('Lifecycle pools unavailable');
    await expect(
      api.query(
        'select * from app.request_workspace_lifecycle_operation($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          workspaceId,
          '1'.repeat(64),
          'deletion_requested',
          ownerUserId,
          'No context',
          'e'.repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      apiWorkspaceQuery(
        'select * from app.request_workspace_lifecycle_operation($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          workspaceId,
          '2'.repeat(64),
          'deletion_requested',
          otherUserId,
          'Forged',
          'c'.repeat(64),
        ],
        otherUserId,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      api.query(
        "select * from app.claim_workspace_lifecycle_operations('api',1,interval '1 minute')",
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      lifecycle.query(
        'select * from app.request_workspace_lifecycle_operation($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          workspaceId,
          '3'.repeat(64),
          'deletion_requested',
          ownerUserId,
          'Forged',
          'd'.repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      lifecycle.query(
        "select app.project_workspace_lifecycle_command(null,null,null,'purge_started',null,null,null,null,null,null,null)",
      ),
    ).rejects.toMatchObject({ code: '42883' });
  });

  it('rejects an accepted operation when owner authorization is lost', async () => {
    if (lifecycle === undefined) throw new Error('Lifecycle pool unavailable');
    const rejectedOperationId = randomUUID();
    await apiWorkspaceQuery(
      'select * from app.request_workspace_lifecycle_operation($1,$2,$3,$4,$5,$6,$7)',
      [
        rejectedOperationId,
        workspaceId,
        '6'.repeat(64),
        'deletion_requested',
        ownerUserId,
        'Authorization will change',
        '8'.repeat(64),
      ],
    );
    const claimed = await lifecycle.query<{
      lease_fence: string;
      lease_token: string;
      operation_id: string;
    }>(
      "select * from app.claim_workspace_lifecycle_operations('command:authorization',2,interval '1 minute')",
    );
    const rejected = claimed.rows.find(
      ({ operation_id }) => operation_id === rejectedOperationId,
    );
    const retained = claimed.rows.find(
      ({ operation_id }) => operation_id === firstOperationId,
    );
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('set role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,false)", [
        workspaceId,
      ]);
      await owner.query(
        "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
        [workspaceId, ownerUserId],
      );
      await expect(
        lifecycle.query(
          'select app.authorize_workspace_lifecycle_append($1,$2,$3)',
          [
            rejected?.operation_id,
            rejected?.lease_token,
            rejected?.lease_fence,
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await lifecycle.query(
        "select app.fail_workspace_lifecycle_operation($1,$2,$3,'authorization_lost')",
        [rejected?.operation_id, rejected?.lease_token, rejected?.lease_fence],
      );
      await lifecycle.query(
        'select app.release_workspace_lifecycle_operation($1,$2,$3)',
        [retained?.operation_id, retained?.lease_token, retained?.lease_fence],
      );
      await owner.query(
        "update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2",
        [workspaceId, ownerUserId],
      );
    } finally {
      await owner.end();
    }
  });

  it('claims with monotonic fencing and rejects a stale release', async () => {
    if (lifecycle === undefined) throw new Error('Lifecycle pool unavailable');
    const first = await lifecycle.query<{
      lease_fence: string;
      lease_token: string;
      operation_id: string;
    }>(
      "select * from app.claim_workspace_lifecycle_operations('command:test',1,interval '10 milliseconds')",
    );
    expect(typeof first.rows[0]?.operation_id).toBe('string');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(
      lifecycle.query(
        'select app.authorize_workspace_lifecycle_append($1,$2,$3)',
        [
          first.rows[0]?.operation_id,
          first.rows[0]?.lease_token,
          first.rows[0]?.lease_fence,
        ],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    const second = await lifecycle.query<{
      lease_fence: string;
      lease_token: string;
      operation_id: string;
    }>(
      "select * from app.claim_workspace_lifecycle_operations('command:test-2',1,interval '1 minute')",
    );
    expect(Number(second.rows[0]?.lease_fence)).toBe(
      Number(first.rows[0]?.lease_fence) + 1,
    );
    const stale = await lifecycle.query<{ released: boolean }>(
      'select app.release_workspace_lifecycle_operation($1,$2,$3) released',
      [
        first.rows[0]?.operation_id,
        first.rows[0]?.lease_token,
        first.rows[0]?.lease_fence,
      ],
    );
    expect(stale.rows[0]?.released).toBe(false);
    const released = await lifecycle.query<{ released: boolean }>(
      'select app.release_workspace_lifecycle_operation($1,$2,$3) released',
      [
        second.rows[0]?.operation_id,
        second.rows[0]?.lease_token,
        second.rows[0]?.lease_fence,
      ],
    );
    expect(released.rows[0]?.released).toBe(true);

    const maximum = await lifecycle.query<{
      lease_fence: string;
      lease_token: string;
      operation_id: string;
    }>(
      "select * from app.claim_workspace_lifecycle_operations('command:max',1,interval '5 minutes')",
    );
    expect(maximum.rows[0]?.operation_id).toBe(firstOperationId);
    await lifecycle.query(
      'select app.release_workspace_lifecycle_operation($1,$2,$3)',
      [
        maximum.rows[0]?.operation_id,
        maximum.rows[0]?.lease_token,
        maximum.rows[0]?.lease_fence,
      ],
    );
  });

  it('binds projection, session revocation, and completion to one live lease', async () => {
    const ledgerCalls: string[] = [];
    let durableRecord: WorkspaceLifecycleLedgerRecord | undefined;
    const reconcileStarted = Promise.withResolvers<undefined>();
    const releaseReconcile = Promise.withResolvers<undefined>();
    let blockFirstReconcile = true;
    const coordinator = createWorkspaceLifecycleCommandCoordinator(
      {
        connectionString: lifecycleUrl,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 2,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      },
      {
        append: (input) => {
          ledgerCalls.push('append');
          durableRecord = {
            ...input,
            recordHash: '9'.repeat(64),
            schemaVersion: 1,
          };
          return Promise.reject(new Error('append response was lost'));
        },
        reconcile: async () => {
          ledgerCalls.push('reconcile');
          if (blockFirstReconcile) {
            blockFirstReconcile = false;
            reconcileStarted.resolve(undefined);
            await releaseReconcile.promise;
          }
          return {
            hasMore: false,
            pageEndHash: durableRecord?.recordHash ?? '0'.repeat(64),
            pageEndSequence: durableRecord?.sequence ?? 0,
            reachedHighWater: true,
            records:
              durableRecord === undefined
                ? ([] as WorkspaceLifecycleLedgerRecord[])
                : [durableRecord],
          };
        },
      },
      {
        externalOperationTimeoutMs: 5_000,
        leaseDurationMs: 60_000,
        leaseOwner: 'command:coordinator',
        statementTimeoutMs: 5_000,
      },
    );
    await expect(
      coordinator.checkReadiness({
        expectedLifecycleCommandRole: 'pertexo_worker',
      }),
    ).rejects.toThrow('Lifecycle command database boundary is incompatible');
    await expect(
      coordinator.checkReadiness({
        expectedLifecycleCommandRole: 'pertexo_lifecycle_command',
      }),
    ).resolves.toBeUndefined();
    try {
      const firstAttempt = coordinator.processNext();
      await reconcileStarted.promise;
      const admin = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        const activity = await admin.query<{ count: string }>(
          `select count(*)::text count from pg_stat_activity
           where datname=$1 and usename='pertexo_lifecycle_command'
             and xact_start is not null`,
          [databaseName],
        );
        expect(activity.rows[0]?.count).toBe('0');
      } finally {
        await admin.end();
        releaseReconcile.resolve(undefined);
      }
      await expect(firstAttempt).resolves.toEqual({
        commandType: 'deletion_requested',
        operationId: firstOperationId,
        status: 'released',
      });
      await expect(coordinator.processNext()).resolves.toEqual({
        commandType: 'deletion_requested',
        operationId: firstOperationId,
        status: 'completed',
      });
      expect(ledgerCalls).toEqual(['reconcile', 'append', 'reconcile']);
    } finally {
      await coordinator.close();
    }

    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('set role pertexo_owner');
      const result = await owner.query<{
        operation_status: string;
        session_revoked: boolean;
        workspace_status: string;
      }>(
        `select workspace.status workspace_status,
                operation.status operation_status,
                session_record.revoked_at is not null session_revoked
         from app.workspaces workspace
         join app.workspace_lifecycle_operations operation
           on operation.workspace_id=workspace.id
         join app.sessions session_record on session_record.user_id=$2
         where workspace.id=$1 and operation.id=$3`,
        [workspaceId, ownerUserId, firstOperationId],
      );
      expect(result.rows[0]).toEqual({
        operation_status: 'completed',
        session_revoked: true,
        workspace_status: 'pending_deletion',
      });
      const effects = await apiWorkspaceQuery(
        `select
          (select status from app.connections where id=$2) connection_status,
          (select cancel_requested_at is not null from app.workflow_runs where id=$3)
            queued_cancel_requested,
          (select scheduler_state->>'runStatus' from app.run_checkpoints
            where workflow_run_id=$3) queued_checkpoint_status,
          (select status from app.workflow_runs where id=$3) queued_status,
          (select cancel_requested_at is not null from app.workflow_runs where id=$4)
            running_cancel_requested,
          (select count(*) from app.outbox_events where workspace_id=$1
            and aggregate_id=$4 and job_name='advance-workflow-run') running_wakeup_count,
          (select lease_token is null from app.trigger_schedules where trigger_id=$5)
            schedule_lease_cleared,
          (select status from app.trigger_schedules where trigger_id=$5) schedule_status,
          (select bool_and(status='disabled' and health_status='disabled')
            from app.workflow_triggers where workspace_id=$1) triggers_disabled,
          (select activation_status from app.workflows where id=$6) workflow_status`,
        [
          workspaceId,
          connectionId,
          queuedRunId,
          runningRunId,
          scheduleTriggerId,
          workflowId,
        ],
      );
      expect(effects.rows[0]).toEqual({
        connection_status: 'reauthorization_required',
        queued_cancel_requested: true,
        queued_checkpoint_status: 'canceled',
        queued_status: 'canceled',
        running_cancel_requested: true,
        running_wakeup_count: '1',
        schedule_lease_cleared: true,
        schedule_status: 'disabled',
        triggers_disabled: true,
        workflow_status: 'inactive',
      });
    } finally {
      await owner.end();
    }
  });

  it('rejects a restore that waited past its durable recovery deadline', async () => {
    if (lifecycle === undefined) throw new Error('Lifecycle pool unavailable');
    const restoreOperationId = randomUUID();
    await apiWorkspaceQuery(
      'select * from app.request_workspace_lifecycle_operation($1,$2,$3,$4,$5,$6,$7)',
      [
        restoreOperationId,
        workspaceId,
        '4'.repeat(64),
        'deletion_restored',
        ownerUserId,
        'Restore workspace',
        '5'.repeat(64),
      ],
    );
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('set role pertexo_owner');
      await owner.query(
        `update app.workspaces
         set purge_after=deletion_requested_at+interval '1 microsecond'
         where id=$1`,
        [workspaceId],
      );
    } finally {
      await owner.end();
    }
    const claimed = await lifecycle.query<{
      lease_fence: string;
      lease_token: string;
      operation_id: string;
    }>(
      "select * from app.claim_workspace_lifecycle_operations('command:late-restore',1,interval '1 minute')",
    );
    expect(claimed.rows[0]?.operation_id).toBe(restoreOperationId);
    await expect(
      lifecycle.query(
        'select app.authorize_workspace_lifecycle_append($1,$2,$3)',
        [
          claimed.rows[0]?.operation_id,
          claimed.rows[0]?.lease_token,
          claimed.rows[0]?.lease_fence,
        ],
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });
});
