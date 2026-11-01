import { createHash } from 'node:crypto';

import { Pool, type QueryResultRow } from 'pg';

import { createIdentityWorkspaceDatabase } from '../../../src/tenant-access/repository.js';
import {
  migrateDatabase,
  dropDisconnectedDatabase,
} from '@pertexo/database/testing';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/primitives';
import type { WorkflowAuthoringDatabase } from '../../../src/authoring/workflows/contract.js';
import { createWorkflowAuthoringFixtureDatabase as createWorkflowAuthoringDatabase } from '../../support/workflow-authoring-admission.fixture.js';

import { createWebhookTriggerDatabase } from '../../../src/triggers/webhooks/store.js';
import { createWorkflowTriggerReconciliationDatabase } from '../../../src/triggers/reconciliation/store.js';
import { createScheduleTriggerDatabase } from '../../../src/triggers/schedules/store.js';

import {
  adminUrl,
  migrationBaseUrl,
  apiBaseUrl,
  workerBaseUrl,
  databaseName,
  url,
  actorId,
  workspaceId,
  workflowId,
  versionId,
  triggerId,
  outboxEventId,
  notificationConnectionId,
  notificationSecretVersionId,
  notificationDestinationId,
  migrationConfig,
  apiConfig,
  workerConfig,
  triggerCatalog,
} from './context.js';

let identity: ReturnType<typeof createIdentityWorkspaceDatabase>;

export let reconciliation: ReturnType<
  typeof createWorkflowTriggerReconciliationDatabase
>;

export let schedules: ReturnType<typeof createScheduleTriggerDatabase>;

export let webhook: ReturnType<typeof createWebhookTriggerDatabase>;

export let owner: Pool;

export let readinessPool: Pool;

export let workerReadinessPool: Pool;

export let workerPool: Pool;

export let authoring: WorkflowAuthoringDatabase;

export async function ownerQuery<Row extends QueryResultRow = QueryResultRow>(
  statement: string,
  parameters: unknown[] = [],
) {
  const client = await owner.connect();
  let releaseClient = (): void => {
    client.release();
  };
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await client.query<Row>(statement, parameters);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    try {
      await client.query('rollback');
    } catch (rollbackError: unknown) {
      releaseClient = () => undefined;
      try {
        client.release(
          new Error('Webhook fixture owner rollback failed', {
            cause: rollbackError,
          }),
        );
      } catch {
        // Preserve the scenario failure after attempting to discard the client.
      }
    }
    throw error;
  } finally {
    releaseClient();
  }
}

export async function beforeAllFixture1() {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,pertexo_app,pertexo_app,pertexo_maintenance`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase(migrationConfig);
  owner = new Pool({ connectionString: url(migrationBaseUrl), max: 1 });
  readinessPool = new Pool({ connectionString: url(apiBaseUrl), max: 1 });
  workerReadinessPool = new Pool({
    connectionString: url(workerBaseUrl),
    max: 1,
  });
  workerPool = new Pool({ connectionString: url(workerBaseUrl), max: 1 });
  identity = createIdentityWorkspaceDatabase(apiConfig);
  reconciliation = createWorkflowTriggerReconciliationDatabase(workerConfig);
  schedules = createScheduleTriggerDatabase(apiConfig);
  webhook = createWebhookTriggerDatabase(apiConfig, undefined, {
    burstLimit: 60,
  });
  authoring = createWorkflowAuthoringDatabase(apiConfig, {
    definitionCatalog: triggerCatalog,
    executableCompiler: (graph) => ({
      checksum: `wf:sha256:${createHash('sha256')
        .update(JSON.stringify(graph))
        .digest('hex')}`,
      executableJson: {
        graph,
      },
    }),
  });
  await identity.createUser({
    id: actorId,
    email: `webhook-${actorId}@example.test`,
    displayName: 'Webhook Owner',
  });
  await identity.createWorkspaceWithOwner({
    id: workspaceId,
    name: 'Webhook Workspace',
    slug: `webhook-${actorId}`,
    ownerUserId: actorId,
    idempotencyKey: `webhook-${actorId}`,
  });
  const payload = {
    workspaceId,
    outboxEventId,
    workflowId,
    publishedVersionId: versionId,
  };
  await ownerQuery(
    `insert into app.workflows(id,workspace_id,name,lifecycle_status,activation_status,
       published_version_id,created_by) values($1,$2,'Webhook','active','inactive',null,$3)`,
    [workflowId, workspaceId, actorId],
  );
  await ownerQuery(
    `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
     values($1,$2,$3,1,$4::jsonb,$5,'{}'::jsonb,$6)`,
    [
      versionId,
      workspaceId,
      workflowId,
      JSON.stringify({ settings: {}, nodes: [], edges: [] }),
      `wf:sha256:${'a'.repeat(64)}`,
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
     values($1,$2,'email','Webhook notifications','resend_api_key','active',$3,$4) returning id)
     insert into app.connection_secret_versions(id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
     select $3,$2,id,'kms','key','cipher','AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA',$4
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
        toEmail: 'webhook@example.test',
      }),
      actorId,
    ],
  );
  await ownerQuery(
    `insert into app.workflow_failure_notification_policies
       (workspace_id,workflow_id,destination_id,updated_by) values($1,$2,$3,$4)`,
    [workspaceId, workflowId, notificationDestinationId, actorId],
  );
  await ownerQuery(
    `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,
       node_id,kind,status,desired_config,config_fingerprint)
     values($1,$2,$3,$4,'webhook','webhook','desired','{}'::jsonb,$5)`,
    [
      triggerId,
      workspaceId,
      workflowId,
      versionId,
      `trigger:sha256:${'b'.repeat(64)}`,
    ],
  );
  await ownerQuery(
    `insert into app.outbox_events(id,workspace_id,job_name,
       aggregate_type,aggregate_id,payload,payload_checksum)
     values($1,$2,'reconcile-workflow-triggers','workflow',$3,$4::jsonb,$5)`,
    [
      outboxEventId,
      workspaceId,
      workflowId,
      JSON.stringify(payload),
      canonicalOutboxPayloadChecksum(payload),
    ],
  );
}

export async function afterAllFixture2() {
  const settle = <Resource>(
    resource: Resource | undefined,
    operation: (value: Resource) => Promise<unknown>,
  ): Promise<unknown> | undefined =>
    resource === undefined ? undefined : operation(resource);
  const cleanup = await Promise.allSettled([
    settle(webhook, (resource) => resource.close()),
    settle(reconciliation, (resource) => resource.close()),
    settle(schedules, (resource) => resource.close()),
    settle(identity, (resource) => resource.close()),
    settle(authoring, (resource) => resource.close()),
    settle(owner, (resource) => resource.end()),
    settle(readinessPool, (resource) => resource.end()),
    settle(workerReadinessPool, (resource) => resource.end()),
    settle(workerPool, (resource) => resource.end()),
  ]);
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
  const failures: unknown[] = [];
  for (const result of cleanup)
    if (result.status === 'rejected') failures.push(result.reason);
  if (failures.length > 0)
    throw new AggregateError(failures, 'Webhook fixture cleanup failed');
}
