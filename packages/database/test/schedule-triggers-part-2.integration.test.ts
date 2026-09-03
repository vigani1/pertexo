import { createHash, randomUUID } from 'node:crypto';

import { Pool, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createIdentityWorkspaceDatabase } from '../src/identity-workspace.js';
import { migrateDatabase } from '../src/migrations.js';
import { acceptWorkflowRun } from '../src/execution-acceptance.js';
import { createWorkspaceDatabase } from '../src/database.js';
import { createOperatorCommandDatabase } from '../src/operator-commands.js';
import { createOperatorRunReplayStore } from '../src/operator-run-replay.js';
import { canonicalOutboxPayloadChecksum } from '../src/outbox.js';
import { checkDatabaseReadiness } from '../src/readiness.js';
import {
  createScheduleTriggerDatabase,
  createScheduleTriggerScanner,
} from '../src/schedule-triggers.js';
import { createWorkflowTriggerReconciliationDatabase } from '../src/workflow-triggers.js';
import { PHASE3_COMPATIBILITY_EXPECTATION } from './phase3-compatibility-fixture.js';
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
const workerBaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const operatorBaseUrl =
  process.env.DATABASE_OPERATOR_URL ??
  'postgresql://pertexo_operator:pertexo-local-operator@localhost:5432/pertexo';
const databaseName = `pertexo_test_schedule_${randomUUID().replaceAll('-', '')}`;
const url = (base: string): string => {
  const parsed = new URL(base);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
};

const actorId = randomUUID();
const workspaceId = randomUUID();
const workflowId = randomUUID();
const versionId = randomUUID();
let replaySourceRunId = '';
const triggerId = randomUUID();
const skipTriggerId = randomUUID();
const quotaTriggerId = randomUUID();
const notificationConnectionId = randomUUID();
const notificationSecretVersionId = randomUUID();
const notificationDestinationId = randomUUID();
const migrationConfig = {
  connectionString: url(migrationBaseUrl),
  ownerRole: 'pertexo_owner',
  apiRuntimeRole: 'pertexo_api',
  workerRuntimeRole: 'pertexo_worker',
  dispatcherRole: 'pertexo_dispatcher',
  maintenanceRole: 'pertexo_maintenance',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  operatorRole: 'pertexo_operator',
} as const;
const apiConfig = parseDatabaseConfig({ connectionString: url(apiBaseUrl) });
const workerConfig = parseDatabaseConfig({
  connectionString: url(workerBaseUrl),
  max: 8,
});
const identity = createIdentityWorkspaceDatabase(apiConfig);
const reconciliation = createWorkflowTriggerReconciliationDatabase(apiConfig);
const schedules = createScheduleTriggerDatabase(apiConfig);
const scannerOne = createScheduleTriggerScanner(
  workerConfig,
  PHASE3_COMPATIBILITY_EXPECTATION,
  apiConfig,
);
const scannerTwo = createScheduleTriggerScanner(
  workerConfig,
  PHASE3_COMPATIBILITY_EXPECTATION,
  apiConfig,
);
const owner = new Pool({ connectionString: url(migrationBaseUrl), max: 1 });
const worker = new Pool({ connectionString: url(workerBaseUrl), max: 1 });
const operator = createOperatorCommandDatabase(
  parseDatabaseConfig({ connectionString: url(operatorBaseUrl), max: 1 }),
);

async function ownerQuery<Row extends QueryResultRow = QueryResultRow>(
  statement: string,
  parameters: unknown[] = [],
  scopedWorkspaceId = workspaceId,
) {
  const client = await owner.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      scopedWorkspaceId,
    ]);
    const result = await client.query<Row>(statement, parameters);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const checkpointFactory = () => ({
  engineVersion: 'schedule-test-engine',
  checkpoint: {
    schemaVersion: 1,
    engineVersion: 'schedule-test-engine',
    workflowVersionId: versionId,
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
  },
});
const replayStore = createOperatorRunReplayStore(
  workerConfig,
  [PHASE3_COMPATIBILITY_EXPECTATION],
  checkpointFactory,
);
const sourceRunDatabase = createWorkspaceDatabase(apiConfig);

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,pertexo_api,pertexo_worker,pertexo_dispatcher,pertexo_operator`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase(migrationConfig);
  await identity.createUser({
    id: actorId,
    email: `schedule-${actorId}@example.test`,
    displayName: 'Schedule Owner',
  });
  await identity.createWorkspaceWithOwner({
    id: workspaceId,
    name: 'Schedule Workspace',
    slug: `schedule-${actorId}`,
    ownerUserId: actorId,
    idempotencyKey: `schedule-${actorId}`,
  });
  await ownerQuery(
    `insert into app.workflows(id,workspace_id,name,lifecycle_status,activation_status,
       published_version_id,created_by) values($1,$2,'Schedule','active','active',null,$3)`,
    [workflowId, workspaceId, actorId],
  );
  await ownerQuery(
    `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,
       schema_version,graph_json,checksum,executable_schema_version,executable_json,
       compatibility_release_epoch,published_by)
     values($1,$2,$3,1,1,'{"schemaVersion":1,"settings":{},"nodes":[],"edges":[]}'::jsonb,
       $4,2,'{}'::jsonb,1,$5)`,
    [
      versionId,
      workspaceId,
      workflowId,
      `wf:v2:sha256:${'a'.repeat(64)}`,
      actorId,
    ],
  );
  await ownerQuery(
    'update app.workflows set published_version_id=$2 where id=$1',
    [workflowId, versionId],
  );
  await ownerQuery(
    `with inserted_connection as (insert into app.connections(id,workspace_id,provider_key,name,auth_type,status,
       current_secret_version_id,created_by)
     values($1,$2,'email','Schedule notifications','resend_api_key','active',$3,$4) returning id)
     insert into app.connection_secret_versions(id,workspace_id,connection_id,schema_version,
       kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
     select $3,$2,id,1,'kms','key','cipher','AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA',$4
       from inserted_connection`,
    [
      notificationConnectionId,
      workspaceId,
      notificationSecretVersionId,
      actorId,
    ],
  );
  await ownerQuery(
    `with inserted_destination as (insert into app.failure_notification_destinations
       (id,workspace_id,kind,status,current_config_version,created_by)
     values($1,$2,'email','enabled',1,$4) returning id)
     insert into app.failure_notification_destination_versions
       (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
     select $2,id,1,'email','idempotent_with_key',$3::jsonb,$4 from inserted_destination`,
    [
      notificationDestinationId,
      workspaceId,
      JSON.stringify({
        connectionId: notificationConnectionId,
        toEmail: 'schedule@example.test',
      }),
      actorId,
    ],
  );
  await ownerQuery(
    `insert into app.workflow_failure_notification_policies
       (workspace_id,workflow_id,destination_id,updated_by) values($1,$2,$3,$4)`,
    [workspaceId, workflowId, notificationDestinationId, actorId],
  );
  for (const [id, nodeId, policy, age] of [
    [triggerId, 'schedule-main', 'catch_up_once', '10 minutes'],
    [skipTriggerId, 'schedule-skip', 'skip', '3 minutes'],
  ] as const) {
    const fingerprint = `trigger:v1:sha256:${createHash('sha256').update(id).digest('hex')}`;
    await ownerQuery(
      `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,
         node_id,kind,status,desired_config,config_fingerprint,health_status)
       values($1,$2,$3,$4,$5,'schedule','active',$6::jsonb,$7,'healthy')`,
      [
        id,
        workspaceId,
        workflowId,
        versionId,
        nodeId,
        JSON.stringify({
          kind: 'interval',
          intervalMinutes: 1,
          misfirePolicy: policy,
        }),
        fingerprint,
      ],
    );
    await ownerQuery(
      `insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,
         interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at)
       values($1,$2,'interval',1,$3,$4,clock_timestamp()-$5::interval,
         clock_timestamp()-$5::interval+interval '1 minute')`,
      [id, workspaceId, policy, fingerprint, age],
    );
  }
  const source = await sourceRunDatabase.withWorkspace(
    workspaceId,
    (transaction) =>
      acceptWorkflowRun(transaction, {
        engineVersion: checkpointFactory().engineVersion,
        initialCheckpoint: checkpointFactory().checkpoint,
        keyHash: 'b'.repeat(64),
        operation: 'workflow.run.accept',
        requestHash: 'c'.repeat(64),
        scope: `operator-source:${workflowId}`,
        triggerType: 'manual',
        workflowId,
        workflowVersionId: versionId,
      }),
  );
  replaySourceRunId = source.runId;
  await ownerQuery(
    `update app.workflow_runs set status='succeeded',completed_at=clock_timestamp()
     where id=$1`,
    [replaySourceRunId],
  );
}, 60_000);

afterAll(async () => {
  await scannerOne.close();
  await scannerTwo.close();
  await reconciliation.close();
  await schedules.close();
  await identity.close();
  await operator.close();
  await replayStore.close();
  await sourceRunDatabase.close();
  await worker.end();
  await owner.end();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('schedule trigger PostgreSQL slice', () => {
  it('deduplicates an occurrence and preserves a saturated occurrence until capacity recovers', async () => {
    const first = await ownerQuery<{
      scheduled_at: Date;
      workflow_run_id: string;
    }>(
      'select scheduled_at,workflow_run_id from app.trigger_schedule_occurrences where trigger_id=$1',
      [triggerId],
    );
    const firstOccurrence = first.rows[0];
    if (firstOccurrence === undefined)
      throw new Error('Accepted schedule occurrence missing');
    const scheduledAt = firstOccurrence.scheduled_at;
    await ownerQuery(
      `update app.trigger_schedules set last_fire_at=null,next_fire_at=$2
        where trigger_id=$1`,
      [triggerId, scheduledAt],
    );
    await scannerOne.scanDue({
      leaseOwner: 'duplicate-scanner',
      limit: 1,
      leaseSeconds: 30,
      checkpointFactory,
    });
    const duplicateFacts = await ownerQuery(
      `select (select count(*) from app.trigger_schedule_occurrences where trigger_id=$1) occurrences,
              (select count(*) from app.workflow_runs
                where workflow_id=$2 and trigger_type='schedule') runs`,
      [triggerId, workflowId],
    );
    expect(duplicateFacts.rows[0]).toMatchObject({
      occurrences: '1',
      runs: '1',
    });

    const fingerprint = `trigger:v1:sha256:${createHash('sha256').update(quotaTriggerId).digest('hex')}`;
    await ownerQuery(
      `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,node_id,
         kind,status,desired_config,config_fingerprint,health_status)
       values($1,$2,$3,$4,'schedule-quota','schedule','active',$5::jsonb,$6,'healthy')`,
      [
        quotaTriggerId,
        workspaceId,
        workflowId,
        versionId,
        JSON.stringify({
          kind: 'interval',
          intervalMinutes: 1,
          misfirePolicy: 'catch_up_once',
        }),
        fingerprint,
      ],
    );
    await ownerQuery(
      `insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,interval_minutes,
         misfire_policy,config_fingerprint,anchor_at,next_fire_at)
       values($1,$2,'interval',1,'catch_up_once',$3,clock_timestamp()-interval '2 minutes',
         clock_timestamp()-interval '1 minute')`,
      [quotaTriggerId, workspaceId, fingerprint],
    );
    await ownerQuery(
      `insert into app.workspace_execution_entitlement_versions
         (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
       values($1,2,'active',5,1,'-infinity')`,
      [workspaceId],
    );
    await ownerQuery(
      'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
      [workspaceId],
    );
    await expect(
      scannerOne.scanDue({
        leaseOwner: 'quota-scanner',
        limit: 10,
        leaseSeconds: 30,
        checkpointFactory,
      }),
    ).resolves.toMatchObject({ deferred: 1 });
    const backlog = await ownerQuery<{ due: boolean }>(
      'select next_fire_at<=clock_timestamp() due from app.trigger_schedules where trigger_id=$1',
      [quotaTriggerId],
    );
    expect(backlog.rows[0]?.due).toBe(true);
    await expect(
      ownerQuery(
        `select health_status,last_error_code from app.trigger_schedules where trigger_id=$1`,
        [quotaTriggerId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          health_status: 'degraded',
          last_error_code: 'schedule.admission_throttled',
        },
      ],
    });
    await ownerQuery(
      "update app.workflow_runs set status='succeeded' where id=$1",
      [first.rows[0]?.workflow_run_id],
    );
    await ownerQuery(
      `update app.trigger_schedules set admission_deferred_until=clock_timestamp()
        where trigger_id=$1`,
      [quotaTriggerId],
    );
    await expect(
      scannerOne.scanDue({
        leaseOwner: 'recovery-scanner',
        limit: 10,
        leaseSeconds: 30,
        checkpointFactory,
      }),
    ).resolves.toMatchObject({ accepted: 1 });
    const advanced = await ownerQuery<{ advanced: boolean }>(
      'select next_fire_at>clock_timestamp() advanced from app.trigger_schedules where trigger_id=$1',
      [quotaTriggerId],
    );
    expect(advanced.rows[0]?.advanced).toBe(true);
    await expect(
      ownerQuery(
        `select health_status,last_error_code from app.trigger_schedules where trigger_id=$1`,
        [quotaTriggerId],
      ),
    ).resolves.toMatchObject({
      rows: [{ health_status: 'healthy', last_error_code: null }],
    });
  });

  it('records skip atomically and supersedes a republished configuration without rewriting history', async () => {
    const skipped = await ownerQuery(
      `select disposition,workflow_run_id from app.trigger_schedule_occurrences
        where trigger_id=$1`,
      [skipTriggerId],
    );
    expect(skipped.rows).toEqual([
      { disposition: 'skipped', workflow_run_id: null },
    ]);
    await ownerQuery(
      `update app.trigger_schedules set last_fire_at=null,
         next_fire_at=clock_timestamp()-interval '1 minute'
        where trigger_id=$1`,
      [skipTriggerId],
    );
    const disabledNext = await schedules.setEnabled({
      workspaceId,
      actorId,
      workflowId,
      triggerId: skipTriggerId,
      enabled: false,
      idempotencyKey: 'disable-skip',
      requestHash: createHash('sha256').update('disable-skip').digest('hex'),
    });
    expect(disabledNext.trigger.status).toBe('disabled');
    const retained = await ownerQuery<{ next_fire_at: Date }>(
      'select next_fire_at from app.trigger_schedules where trigger_id=$1',
      [skipTriggerId],
    );
    await schedules.setEnabled({
      workspaceId,
      actorId,
      workflowId,
      triggerId: skipTriggerId,
      enabled: true,
      idempotencyKey: 'enable-skip',
      requestHash: createHash('sha256').update('enable-skip').digest('hex'),
    });
    const reenabled = await ownerQuery<{ advanced: boolean }>(
      `select next_fire_at>$2 advanced from app.trigger_schedules where trigger_id=$1`,
      [skipTriggerId, retained.rows[0]?.next_fire_at],
    );
    expect(reenabled.rows[0]?.advanced).toBe(true);

    const nextVersionId = randomUUID();
    const nextTriggerId = randomUUID();
    const outboxEventId = randomUUID();
    const fingerprint = `trigger:v1:sha256:${createHash('sha256').update(nextTriggerId).digest('hex')}`;
    await ownerQuery(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,schema_version,
         graph_json,checksum,executable_schema_version,executable_json,compatibility_release_epoch,published_by)
       values($1,$2,$3,2,1,'{"schemaVersion":1,"settings":{},"nodes":[],"edges":[]}'::jsonb,
         $4,2,'{}'::jsonb,1,$5)`,
      [
        nextVersionId,
        workspaceId,
        workflowId,
        `wf:v2:sha256:${'b'.repeat(64)}`,
        actorId,
      ],
    );
    await ownerQuery(
      'update app.workflows set published_version_id=$1 where id=$2',
      [nextVersionId, workflowId],
    );
    await ownerQuery(
      `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,node_id,
         kind,status,desired_config,config_fingerprint)
       values($1,$2,$3,$4,'schedule-main','schedule','desired',$5::jsonb,$6)`,
      [
        nextTriggerId,
        workspaceId,
        workflowId,
        nextVersionId,
        JSON.stringify({
          kind: 'interval',
          intervalMinutes: 5,
          misfirePolicy: 'catch_up_once',
        }),
        fingerprint,
      ],
    );
    await ownerQuery(
      `insert into app.outbox_events(id,workspace_id,job_name,schema_version,aggregate_type,
         aggregate_id,payload,payload_checksum)
       values($1,$2,'reconcile-workflow-triggers',1,'workflow',$3,$4::jsonb,$5)`,
      [
        outboxEventId,
        workspaceId,
        workflowId,
        JSON.stringify({
          schemaVersion: 1,
          workspaceId,
          outboxEventId,
          workflowId,
          publishedVersionId: nextVersionId,
        }),
        canonicalOutboxPayloadChecksum({
          schemaVersion: 1,
          workspaceId,
          outboxEventId,
          workflowId,
          publishedVersionId: nextVersionId,
        }),
      ],
    );
    await expect(
      reconciliation.reconcile({
        workspaceId,
        workflowId,
        publishedVersionId: nextVersionId,
        outboxEventId,
      }),
    ).resolves.toMatchObject([{ id: nextTriggerId, status: 'active' }]);
    const state = await ownerQuery(
      `select old.status old_status,new.interval_minutes,
              (select count(*) from app.trigger_schedule_occurrences where trigger_id=$1) old_occurrences
         from app.trigger_schedules old cross join app.trigger_schedules new
        where old.trigger_id=$1 and new.trigger_id=$2`,
      [triggerId, nextTriggerId],
    );
    expect(state.rows[0]).toMatchObject({
      old_status: 'disabled',
      interval_minutes: 5,
      old_occurrences: '1',
    });
  });

  it('lists only current schedule materializations and keeps command replay exact', async () => {
    const listed = await schedules.list({ workspaceId, actorId, workflowId });
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('configFingerprint');
    expect(listed[0]).not.toHaveProperty('leaseOwner');
    const currentTrigger = listed[0];
    if (currentTrigger === undefined)
      throw new Error('Current schedule missing');

    const nextBefore = await ownerQuery<{ next_fire_at: Date }>(
      'select next_fire_at from app.trigger_schedules where trigger_id=$1',
      [currentTrigger.id],
    );
    const command = {
      workspaceId,
      actorId,
      workflowId,
      triggerId: currentTrigger.id,
      enabled: false,
      idempotencyKey: 'disable-main',
      requestHash: createHash('sha256').update('disable-main').digest('hex'),
      requestId: 'schedule-request',
    } as const;
    const first = await schedules.setEnabled(command);
    const replay = await schedules.setEnabled(command);
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    const facts = await ownerQuery<{
      next_fire_at: Date;
      audit_count: string;
    }>(
      `select schedule.next_fire_at,
              (select count(*) from app.audit_events where target_id=$1
                and action='schedule_trigger.disabled') audit_count
         from app.trigger_schedules schedule where schedule.trigger_id=$1`,
      [currentTrigger.id],
    );
    expect(facts.rows[0]?.next_fire_at).toEqual(
      nextBefore.rows[0]?.next_fire_at,
    );
    expect(facts.rows[0]?.audit_count).toBe('1');

    await expect(
      schedules.setEnabled({
        ...command,
        enabled: true,
        requestHash: createHash('sha256').update('enable-main').digest('hex'),
      }),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
      name: 'ScheduleTriggerError',
    });
    await expect(
      schedules.list({
        workspaceId: randomUUID(),
        actorId,
        workflowId,
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
      name: 'ScheduleTriggerError',
    });

    const enabled = await schedules.setEnabled({
      ...command,
      enabled: true,
      idempotencyKey: 'enable-main',
      requestHash: createHash('sha256').update('enable-main').digest('hex'),
    });
    expect(enabled.trigger.nextFireAt).toEqual(first.trigger.nextFireAt);
  });
});
