import { createHash, randomUUID } from 'node:crypto';

import { Pool, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createIdentityWorkspaceDatabase } from '../src/tenant-access/identity-workspace.js';
import { migrateDatabase } from '../src/migrations.js';
import { canonicalOutboxPayloadChecksum } from '../src/execution/outbox.js';
import {
  createWorkflowAuthoringDatabase,
  type WorkflowAuthoringDatabase,
} from '../src/authoring/workflow-authoring.js';
import {
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/graph';
import { checkDatabaseReadiness } from '../src/platform/readiness.js';
import {
  createWebhookTriggerDatabase,
  WebhookDeliveryIneligibleError,
  WebhookDeliveryReplayMismatchError,
  WebhookIngressRateLimitExceededError,
  WebhookTriggerNotFoundError,
} from '../src/triggers/webhook-triggers.js';
import { createWorkflowTriggerReconciliationDatabase } from '../src/triggers/workflow-triggers.js';
import { BASELINE_COMPATIBILITY_EXPECTATION } from './baseline-compatibility-fixture.js';
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
const databaseName = `pertexo_test_webhook_${randomUUID().replaceAll('-', '')}`;
const url = (base: string): string => {
  const parsed = new URL(base);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
};

const actorId = randomUUID();
const workspaceId = randomUUID();
const workflowId = randomUUID();
const versionId = randomUUID();
const triggerId = randomUUID();
const endpointId = randomUUID();
const outboxEventId = randomUUID();
const notificationConnectionId = randomUUID();
const notificationSecretVersionId = randomUUID();
const notificationDestinationId = randomUUID();
const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
const endpointHash = hash('endpoint-one');
const secret = (id = randomUUID()) => ({
  id,
  schemaVersion: 1 as const,
  kmsKeyReference: 'kms://test/webhook',
  encryptedDataKey: `encrypted-key-${id}`,
  ciphertext: `ciphertext-${id}`,
  nonce: 'nonce-value',
  authTag: 'authentication-tag',
});

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
const apiConfig = parseDatabaseConfig({
  connectionString: url(apiBaseUrl),
  max: 8,
});
const workerConfig = parseDatabaseConfig({
  connectionString: url(workerBaseUrl),
  max: 8,
});
const identity = createIdentityWorkspaceDatabase(apiConfig);
const reconciliation =
  createWorkflowTriggerReconciliationDatabase(workerConfig);
const webhook = createWebhookTriggerDatabase(
  apiConfig,
  BASELINE_COMPATIBILITY_EXPECTATION,
);
const owner = new Pool({ connectionString: url(migrationBaseUrl), max: 1 });
const readinessPool = new Pool({ connectionString: url(apiBaseUrl), max: 1 });
const workerReadinessPool = new Pool({
  connectionString: url(workerBaseUrl),
  max: 1,
});
const triggerCatalog = Object.freeze({
  schemaVersion: 1 as const,
  definitions: Object.freeze([
    Object.freeze({ key: 'core.webhook', version: 1 }),
    Object.freeze({ key: 'core.schedule', version: 1 }),
  ]),
});
const authoring: WorkflowAuthoringDatabase = createWorkflowAuthoringDatabase(
  apiConfig,
  { definitionCatalog: triggerCatalog },
);

async function ownerQuery<Row extends QueryResultRow = QueryResultRow>(
  statement: string,
  parameters: unknown[] = [],
) {
  const client = await owner.connect();
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
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const checkpointFactory = () => ({
  engineVersion: 'webhook-test-engine',
  checkpoint: {
    schemaVersion: 1,
    engineVersion: 'webhook-test-engine',
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

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,pertexo_api,pertexo_worker,pertexo_dispatcher`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase(migrationConfig);
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
    schemaVersion: 1,
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
    `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,
       schema_version,graph_json,checksum,executable_schema_version,executable_json,
       compatibility_release_epoch,published_by)
     values($1,$2,$3,1,1,$4::jsonb,$5,2,'{}'::jsonb,1,$6)`,
    [
      versionId,
      workspaceId,
      workflowId,
      JSON.stringify({ schemaVersion: 1, settings: {}, nodes: [], edges: [] }),
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
     values($1,$2,'email','Webhook notifications','resend_api_key','active',$3,$4) returning id)
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
      `trigger:v1:sha256:${'b'.repeat(64)}`,
    ],
  );
  await ownerQuery(
    `insert into app.outbox_events(id,workspace_id,job_name,schema_version,
       aggregate_type,aggregate_id,payload,payload_checksum)
     values($1,$2,'reconcile-workflow-triggers',1,'workflow',$3,$4::jsonb,$5)`,
    [
      outboxEventId,
      workspaceId,
      workflowId,
      JSON.stringify(payload),
      canonicalOutboxPayloadChecksum(payload),
    ],
  );
}, 60_000);

afterAll(async () => {
  await webhook.close();
  await reconciliation.close();
  await identity.close();
  await authoring.close();
  await owner.end();
  await readinessPool.end();
  await workerReadinessPool.end();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('generic webhook database seam', () => {
  it('rebuilds desired webhook and schedule rows inside publication', async () => {
    const created = await authoring.createWorkflow({
      actorId,
      workspaceId,
      name: 'Published trigger projection',
      emptyGraph: { schemaVersion: 1, settings: {}, nodes: [], edges: [] },
      idempotencyKey: 'create-trigger-projection',
    });
    const graph = {
      schemaVersion: 1,
      settings: {},
      nodes: [
        {
          id: 'webhook',
          definition: { key: 'core.webhook', version: 1 },
          position: { x: 0, y: 0 },
          configVersion: 1,
          config: {},
          inputMappings: {},
          connectionRefs: {},
        },
        {
          id: 'schedule',
          definition: { key: 'core.schedule', version: 1 },
          position: { x: 0, y: 100 },
          configVersion: 1,
          config: {
            kind: 'interval',
            intervalMinutes: 15,
            misfirePolicy: 'skip',
          },
          inputMappings: {},
          connectionRefs: {},
        },
      ],
      edges: [],
    };
    const draft = await authoring.saveDraft({
      actorId,
      workspaceId,
      workflowId: created.workflowId,
      expectedRevision: 1,
      graphJson: graph,
    });
    const representationTag = workflowDraftRepresentationTag({
      workflowId: created.workflowId,
      revision: draft.revision,
      graph: draft.graphJson,
      compatibilityFingerprint: workflowCompatibilityReport(
        draft.graphJson,
        triggerCatalog,
      ).fingerprint,
    });
    const published = await authoring.publishWorkflow({
      actorId,
      workspaceId,
      workflowId: created.workflowId,
      representationTag,
      idempotencyKey: 'publish-trigger-projection',
      requestHash: hash('publish-trigger-projection'),
    });
    const event = await ownerQuery<{ id: string }>(
      `select id from app.outbox_events where aggregate_id=$1
        and job_name='reconcile-workflow-triggers'`,
      [created.workflowId],
    );
    const eventId = String(event.rows[0]?.id);
    await expect(
      reconciliation.reconcile({
        workspaceId,
        workflowId: created.workflowId,
        publishedVersionId: published.version.id,
        outboxEventId: eventId,
      }),
    ).resolves.toMatchObject([
      { nodeId: 'schedule', kind: 'schedule', status: 'active' },
      { nodeId: 'webhook', kind: 'webhook', status: 'configuration_required' },
    ]);
  });

  it('migrates from zero, reconciles configuration, and exposes no hashes or secrets in health', async () => {
    await expect(checkDatabaseReadiness(readinessPool)).resolves.toMatchObject({
      migrationHead: '0074_retention_schedule_state_rls.sql',
    });
    await expect(
      checkDatabaseReadiness(workerReadinessPool),
    ).resolves.toMatchObject({
      role: 'pertexo_worker',
    });
    await expect(
      reconciliation.reconcile({
        workspaceId,
        workflowId,
        publishedVersionId: versionId,
        outboxEventId,
      }),
    ).resolves.toMatchObject([
      { id: triggerId, status: 'configuration_required', endpointReady: false },
    ]);
    const health = await webhook.provision({
      workspaceId,
      actorId,
      triggerId,
      endpointId,
      endpointKeyHash: endpointHash,
      secret: secret(),
      idempotencyKey: 'provision',
      requestHash: hash('provision'),
    });
    expect(health).toMatchObject({ status: 'active', endpointReady: true });
    expect(JSON.stringify(health)).not.toMatch(
      /hash|cipher|secret|nonce|authTag/u,
    );
    await expect(
      webhook.getHealth({
        workspaceId,
        actorId: randomUUID(),
        workflowId,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('resolves eligible sealed references and atomically deduplicates concurrent delivery', async () => {
    const verification = await webhook.resolveVerification(endpointHash);
    expect(verification).not.toBeNull();
    if (verification === null) throw new Error('Expected endpoint resolution');
    const input = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint: hash('payload-one'),
      idempotencyKeyHash: hash('sender-key'),
      payload: { event: 'one' },
      checkpointFactory,
    } as const;
    const accepted = await Promise.all([
      webhook.acceptVerifiedDelivery(input),
      webhook.acceptVerifiedDelivery(input),
    ]);
    expect(new Set(accepted.map(({ runId }) => runId)).size).toBe(1);
    expect(accepted.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    const pins = await ownerQuery(
      `select failure_notification_policy_version,
              failure_notification_destination_id,
              failure_notification_destination_config_version,
              failure_notification_side_effect_class,
              failure_notification_connection_secret_version_id
         from app.workflow_runs where id=$1`,
      [accepted[0].runId],
    );
    expect(pins.rows).toEqual([
      {
        failure_notification_policy_version: 1,
        failure_notification_destination_id: notificationDestinationId,
        failure_notification_destination_config_version: 1,
        failure_notification_side_effect_class: 'idempotent_with_key',
        failure_notification_connection_secret_version_id:
          notificationSecretVersionId,
      },
    ]);
    await expect(
      webhook.acceptVerifiedDelivery({
        ...input,
        requestFingerprint: hash('changed-payload'),
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryReplayMismatchError);
    const retention = await ownerQuery<{
      delivery_seconds: number;
      replay_seconds: number;
    }>(
      `select extract(epoch from delivery.expires_at-delivery.received_at)::integer delivery_seconds,
              extract(epoch from replay.expires_at-replay.created_at)::integer replay_seconds
         from app.webhook_trigger_deliveries delivery
         join app.webhook_trigger_replay_records replay on replay.delivery_id=delivery.id
        where delivery.endpoint_id=$1`,
      [endpointId],
    );
    expect(retention.rows[0]).toEqual({
      delivery_seconds: 90 * 24 * 60 * 60,
      replay_seconds: 24 * 60 * 60,
    });
  });

  it('enforces the endpoint ingress boundary atomically under concurrency', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 61 }, () =>
        webhook.consumeIngressLimit(endpointHash),
      ),
    );
    expect(
      attempts.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(60);
    const denied = attempts.filter(({ status }) => status === 'rejected');
    expect(denied).toHaveLength(1);
    expect((denied[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      WebhookIngressRateLimitExceededError,
    );
  });

  it('invalidates old endpoint references at rotation commit and bounds prior secrets', async () => {
    await ownerQuery(
      "update app.workspace_memberships set role='builder' where workspace_id=$1 and user_id=$2",
      [workspaceId, actorId],
    );
    const oldVerification = await webhook.resolveVerification(endpointHash);
    if (oldVerification === null) throw new Error('Expected old endpoint');
    const nextEndpointHash = hash('endpoint-two');
    await webhook.rotateEndpoint({
      workspaceId,
      actorId,
      triggerId,
      endpointKeyHash: nextEndpointHash,
      idempotencyKey: 'rotate-endpoint',
      requestHash: hash('rotate-endpoint'),
    });
    await expect(webhook.resolveVerification(endpointHash)).resolves.toBeNull();
    await expect(
      webhook.acceptVerifiedDelivery({
        verification: oldVerification,
        verifiedSecretVersionId: oldVerification.currentSecret.id,
        requestFingerprint: hash('rotation-race'),
        payload: { event: 'rotation-race' },
        checkpointFactory,
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryIneligibleError);

    const beforeSecretRotation =
      await webhook.resolveVerification(nextEndpointHash);
    if (beforeSecretRotation === null)
      throw new Error('Expected rotated endpoint');
    const nextSecret = secret();
    const beforeWrongKey = await ownerQuery(
      `select endpoint.current_secret_version_id,
              (select count(*)::integer from app.webhook_trigger_secret_versions
                where trigger_id=$1) secret_count
         from app.webhook_trigger_endpoints endpoint where endpoint.trigger_id=$1`,
      [triggerId],
    );
    await expect(
      webhook.rotateSecret({
        workspaceId,
        actorId,
        triggerId,
        endpointKeyHash: hash('wrong-endpoint'),
        secret: nextSecret,
        idempotencyKey: 'rotate-secret-wrong-key',
        requestHash: hash('rotate-secret-wrong-key'),
      }),
    ).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
    const afterWrongKey = await ownerQuery(
      `select endpoint.current_secret_version_id,
              (select count(*)::integer from app.webhook_trigger_secret_versions
                where trigger_id=$1) secret_count
         from app.webhook_trigger_endpoints endpoint where endpoint.trigger_id=$1`,
      [triggerId],
    );
    expect(afterWrongKey.rows).toEqual(beforeWrongKey.rows);
    await webhook.rotateSecret({
      workspaceId,
      actorId,
      triggerId,
      endpointKeyHash: nextEndpointHash,
      secret: nextSecret,
      idempotencyKey: 'rotate-secret',
      requestHash: hash('rotate-secret'),
    });
    const after = await webhook.resolveVerification(nextEndpointHash);
    expect(after?.currentSecret.id).toBe(nextSecret.id);
    expect(after?.previousSecret?.id).toBe(
      beforeSecretRotation.currentSecret.id,
    );
    expect(
      (after?.previousSecret?.validUntil.getTime() ?? 0) - Date.now(),
    ).toBeGreaterThan(290_000);
  });

  it('rolls back replay and delivery admission when workspace eligibility changes', async () => {
    const verification = await webhook.resolveVerification(
      hash('endpoint-two'),
    );
    if (verification === null) throw new Error('Expected endpoint');
    await ownerQuery(
      "update app.workspaces set status='suspended' where id=$1",
      [workspaceId],
    );
    const input = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint: hash('rollback-payload'),
      idempotencyKeyHash: hash('rollback-key'),
      payload: { event: 'rollback' },
      checkpointFactory,
    } as const;
    await expect(webhook.acceptVerifiedDelivery(input)).rejects.toBeInstanceOf(
      WebhookDeliveryIneligibleError,
    );
    await ownerQuery("update app.workspaces set status='active' where id=$1", [
      workspaceId,
    ]);
    await expect(webhook.acceptVerifiedDelivery(input)).resolves.toMatchObject({
      replayed: false,
    });
  });
});
