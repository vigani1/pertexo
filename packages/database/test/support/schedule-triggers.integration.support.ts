import { createHash, randomUUID } from 'node:crypto';

import { Pool, type QueryResultRow } from 'pg';

import { parseDatabaseConfig } from '../../src/config.js';
import { createWorkspaceDatabase } from '../../src/database.js';
import { acceptWorkflowRun } from '../../src/execution-acceptance.js';
import { createIdentityWorkspaceDatabase } from '../../src/identity-workspace.js';
import { migrateDatabase } from '../../src/migrations.js';
import { createOperatorCommandDatabase } from '../../src/operator-commands.js';
import { createOperatorRunReplayStore } from '../../src/operator-run-replay.js';
import {
  createScheduleTriggerDatabase,
  createScheduleTriggerScanner,
} from '../../src/triggers/schedule-triggers.js';
import { createWorkflowTriggerReconciliationDatabase } from '../../src/triggers/workflow-triggers.js';
import { PHASE3_COMPATIBILITY_EXPECTATION } from '../phase3-compatibility-fixture.js';
import { dropDisconnectedDatabase } from './disposable-database.js';

export function createScheduleTriggerTestEnvironment() {
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

  const initialize = async (): Promise<string> => {
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await admin.query(
        `create database "${databaseName}" owner pertexo_owner`,
      );
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
    return replaySourceRunId;
  };

  const close = async (): Promise<void> => {
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
  };

  return {
    actorId,
    checkpointFactory,
    close,
    identity,
    initialize,
    notificationDestinationId,
    notificationSecretVersionId,
    operator,
    ownerQuery,
    reconciliation,
    replayStore,
    scannerOne,
    scannerTwo,
    schedules,
    skipTriggerId,
    sourceRunDatabase,
    triggerId,
    versionId,
    worker,
    workflowId,
    workspaceId,
  };
}
