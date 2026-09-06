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
import {
  createWorkflowTriggerReconciliationDatabase,
  WorkflowTriggerStalePublicationError,
} from '../src/triggers/workflow-triggers.js';
import {
  createScheduleTriggerDatabase,
  ScheduleTriggerError,
} from '../src/triggers/schedule-triggers.js';
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
const schedules = createScheduleTriggerDatabase(apiConfig);
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
const workerPool = new Pool({ connectionString: url(workerBaseUrl), max: 1 });
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

async function workerQuery<Row extends QueryResultRow = QueryResultRow>(
  statement: string,
  parameters: unknown[] = [],
) {
  const client = await workerPool.connect();
  try {
    await client.query('begin');
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
  await schedules.close();
  await identity.close();
  await authoring.close();
  await owner.end();
  await readinessPool.end();
  await workerReadinessPool.end();
  await workerPool.end();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('generic webhook database seam', () => {
  function triggerGraph(intervalMinutes = 15) {
    return {
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
            intervalMinutes,
            misfirePolicy: 'skip',
          },
          inputMappings: {},
          connectionRefs: {},
        },
      ],
      edges: [],
    };
  }

  async function workflowTriggerIds(workflowIdInput: string) {
    const result = await ownerQuery<{
      id: string;
      kind: 'webhook' | 'schedule';
      node_id: string;
    }>(
      `select id,kind,node_id from app.workflow_triggers
         where workspace_id=$1 and workflow_id=$2
           and workflow_version_id=(select published_version_id from app.workflows
             where workspace_id=$1 and id=$2)
         order by node_id`,
      [workspaceId, workflowIdInput],
    );
    const webhookTrigger = result.rows.find(({ kind }) => kind === 'webhook');
    const scheduleTrigger = result.rows.find(({ kind }) => kind === 'schedule');
    if (webhookTrigger === undefined || scheduleTrigger === undefined)
      throw new Error('Published trigger projection is incomplete');
    return Object.freeze({
      webhookId: webhookTrigger.id,
      scheduleId: scheduleTrigger.id,
    });
  }

  async function appendReconciliationEvent(
    workflowIdInput: string,
    versionIdInput: string,
  ) {
    const eventId = randomUUID();
    const payload = {
      schemaVersion: 1,
      workspaceId,
      outboxEventId: eventId,
      workflowId: workflowIdInput,
      publishedVersionId: versionIdInput,
    };
    const payloadChecksum = canonicalOutboxPayloadChecksum(payload);
    await ownerQuery(
      `insert into app.outbox_events(id,workspace_id,job_name,schema_version,
         aggregate_type,aggregate_id,payload,payload_checksum)
       values($1,$2,'reconcile-workflow-triggers',1,'workflow',$3,$4::jsonb,$5)`,
      [
        eventId,
        workspaceId,
        workflowIdInput,
        JSON.stringify(payload),
        payloadChecksum,
      ],
    );
    return Object.freeze({ eventId, payloadChecksum });
  }

  async function deliverReconciliation(
    workflowIdInput: string,
    versionIdInput: string,
    event: Readonly<{ eventId: string; payloadChecksum: string }>,
  ) {
    return reconciliation.reconcile({
      workspaceId,
      workflowId: workflowIdInput,
      publishedVersionId: versionIdInput,
      outboxEventId: event.eventId,
      delivery: {
        outboxEventId: event.eventId,
        payloadChecksum: event.payloadChecksum,
      },
    });
  }

  async function setWorkflowLifecycle(
    workflowIdInput: string,
    lifecycleStatus: 'active' | 'archived',
    activationStatus:
      | 'inactive'
      | 'activating'
      | 'active'
      | 'deactivating'
      | 'degraded'
      | 'error',
  ): Promise<void> {
    await ownerQuery(
      `update app.workflows set lifecycle_status=$2,activation_status=$3,
         updated_at=clock_timestamp() where workspace_id=$1 and id=$4`,
      [workspaceId, lifecycleStatus, activationStatus, workflowIdInput],
    );
  }

  async function immutableWorkflowHistory(workflowIdInput: string) {
    const draft = await ownerQuery<{
      graph_json: unknown;
      revision: number;
    }>(
      `select revision,graph_json from app.workflow_drafts
         where workspace_id=$1 and workflow_id=$2`,
      [workspaceId, workflowIdInput],
    );
    const versions = await ownerQuery<{
      checksum: string;
      graph_json: unknown;
      id: string;
      version_number: number;
    }>(
      `select id,version_number,checksum,graph_json from app.workflow_versions
         where workspace_id=$1 and workflow_id=$2 order by version_number`,
      [workspaceId, workflowIdInput],
    );
    const runs = await ownerQuery<{
      created_at: Date;
      id: string;
      status: string;
      trigger_type: string;
      updated_at: Date;
      workflow_version_id: string;
    }>(
      `select id,status,trigger_type,workflow_version_id,created_at,updated_at
         from app.workflow_runs where workspace_id=$1 and workflow_id=$2
         order by id`,
      [workspaceId, workflowIdInput],
    );
    return Object.freeze({
      draft: draft.rows,
      runs: runs.rows,
      versions: versions.rows,
    });
  }

  async function publishTriggerWorkflow() {
    const created = await authoring.createWorkflow({
      actorId,
      workspaceId,
      name: 'Published trigger projection',
      emptyGraph: { schemaVersion: 1, settings: {}, nodes: [], edges: [] },
      idempotencyKey: randomUUID(),
    });
    const graph = triggerGraph();
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
      idempotencyKey: randomUUID(),
      requestHash: hash('publish-trigger-projection'),
    });
    const event = await ownerQuery<{ id: string }>(
      `select id from app.outbox_events where aggregate_id=$1
      and job_name='reconcile-workflow-triggers'`,
      [created.workflowId],
    );
    const eventId = event.rows[0]?.id;
    if (eventId === undefined) throw new Error('Reconciliation event missing');
    return {
      created,
      eventChecksum: await ownerQuery<{ payload_checksum: string }>(
        'select payload_checksum from app.outbox_events where id=$1',
        [eventId],
      ).then((result) => {
        const checksum = result.rows[0]?.payload_checksum;
        if (checksum === undefined)
          throw new Error('Reconciliation checksum missing');
        return checksum;
      }),
      eventId,
      published,
    };
  }

  async function publishNextTriggerWorkflowVersion(workflowIdInput: string) {
    const currentDraft = await authoring.getDraft(
      workspaceId,
      workflowIdInput,
      actorId,
    );
    if (currentDraft === null) throw new Error('Workflow draft is missing');
    const draft = await authoring.saveDraft({
      actorId,
      workspaceId,
      workflowId: workflowIdInput,
      expectedRevision: currentDraft.revision,
      graphJson: triggerGraph(30),
    });
    const representationTag = workflowDraftRepresentationTag({
      workflowId: workflowIdInput,
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
      workflowId: workflowIdInput,
      representationTag,
      idempotencyKey: randomUUID(),
      requestHash: hash(randomUUID()),
    });
    const event = await ownerQuery<{
      id: string;
      payload_checksum: string;
    }>(
      `select id,payload_checksum from app.outbox_events
         where workspace_id=$1 and aggregate_id=$2
           and job_name='reconcile-workflow-triggers'
           and payload->>'publishedVersionId'=$3
         order by created_at desc limit 1`,
      [workspaceId, workflowIdInput, published.version.id],
    );
    const row = event.rows[0];
    if (row === undefined)
      throw new Error('Latest reconciliation event missing');
    return Object.freeze({
      eventChecksum: row.payload_checksum,
      eventId: row.id,
      published,
    });
  }

  async function provisionWebhook(workflowIdInput: string) {
    const ids = await workflowTriggerIds(workflowIdInput);
    const endpointKeyHash = hash(`endpoint-${randomUUID()}`);
    const endpointId = randomUUID();
    const health = await webhook.provision({
      workspaceId,
      actorId,
      triggerId: ids.webhookId,
      endpointId,
      endpointKeyHash,
      secret: secret(),
      idempotencyKey: randomUUID(),
      requestHash: hash(randomUUID()),
    });
    return Object.freeze({ endpointId, endpointKeyHash, health, ...ids });
  }

  async function triggerFacts(workflowIdInput: string) {
    const result = await ownerQuery<{
      endpoint_status: 'active' | 'disabled' | null;
      endpoint_ready: boolean;
      endpoint_id: string | null;
      health_status: string;
      kind: string;
      last_error_code: string | null;
      node_id: string;
      schedule_health_status: string | null;
      schedule_status: 'enabled' | 'disabled' | null;
      status: string;
      trigger_id: string;
    }>(
      `select trigger.id trigger_id,trigger.node_id,trigger.kind,trigger.status,
              trigger.health_status,trigger.last_error_code,
              endpoint.id endpoint_id,endpoint.status endpoint_status,
              (endpoint.id is not null and endpoint.status='active') endpoint_ready,
              schedule.status schedule_status,schedule.health_status schedule_health_status
         from app.workflow_triggers trigger
         left join app.webhook_trigger_endpoints endpoint
           on endpoint.workspace_id=trigger.workspace_id and endpoint.trigger_id=trigger.id
         left join app.trigger_schedules schedule
           on schedule.workspace_id=trigger.workspace_id and schedule.trigger_id=trigger.id
        where trigger.workspace_id=$1 and trigger.workflow_id=$2
          and trigger.workflow_version_id=(select published_version_id from app.workflows
            where workspace_id=$1 and id=$2)
        order by trigger.node_id`,
      [workspaceId, workflowIdInput],
    );
    return result.rows;
  }

  async function workflowState(workflowIdInput: string) {
    const result = await ownerQuery<{
      activation_status: string;
      lifecycle_status: string;
      published_version_id: string | null;
    }>(
      `select lifecycle_status,activation_status,published_version_id
         from app.workflows where workspace_id=$1 and id=$2`,
      [workspaceId, workflowIdInput],
    );
    const state = result.rows[0];
    if (state === undefined) throw new Error('Workflow state is missing');
    return state;
  }

  it('rebuilds desired webhook and schedule rows inside publication', async () => {
    const { created, published, eventId } = await publishTriggerWorkflow();
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

  it('applies archive state at reconciliation and gates new trigger work', async () => {
    const { created, published } = await publishTriggerWorkflow();
    const event = await appendReconciliationEvent(
      created.workflowId,
      published.version.id,
    );
    await expect(
      deliverReconciliation(created.workflowId, published.version.id, event),
    ).resolves.toHaveLength(2);
    const provisioned = await provisionWebhook(created.workflowId);
    const verification = await webhook.resolveVerification(
      provisioned.endpointKeyHash,
    );
    if (verification === null) throw new Error('Expected webhook verification');
    const historyBeforeArchive = await immutableWorkflowHistory(
      created.workflowId,
    );
    await ownerQuery(
      `update app.trigger_schedules set next_fire_at=clock_timestamp()-interval '1 minute'
         where workspace_id=$1 and trigger_id=$2`,
      [workspaceId, provisioned.scheduleId],
    );
    await setWorkflowLifecycle(created.workflowId, 'archived', 'deactivating');
    await expect(
      webhook.resolveVerification(provisioned.endpointKeyHash),
    ).resolves.toBeNull();
    await expect(
      webhook.acceptVerifiedDelivery({
        verification,
        verifiedSecretVersionId: verification.currentSecret.id,
        requestFingerprint: hash('archived-webhook-admission'),
        payload: { archived: true },
        checkpointFactory,
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryIneligibleError);
    const claimed = await workerQuery<{
      lease_token: string;
      trigger_id: string;
    }>(
      'select trigger_id,lease_token from app.claim_due_trigger_schedules($1,1,30)',
      [`archive-gate-${randomUUID()}`],
    );
    expect(claimed.rows).toHaveLength(1);
    const claim = claimed.rows[0];
    if (claim === undefined) throw new Error('Archived schedule claim missing');
    const eligible = await workerQuery<{ eligible: boolean }>(
      'select app.schedule_claim_is_eligible($1,$2) eligible',
      [claim.trigger_id, claim.lease_token],
    );
    expect(eligible.rows[0]?.eligible).toBe(false);
    await workerQuery('select app.release_trigger_schedule_claim($1,$2)', [
      claim.trigger_id,
      claim.lease_token,
    ]);
    await expect(
      schedules.setEnabled({
        workspaceId,
        actorId,
        workflowId: created.workflowId,
        triggerId: provisioned.scheduleId,
        enabled: true,
        idempotencyKey: randomUUID(),
        requestHash: hash(randomUUID()),
      }),
    ).rejects.toBeInstanceOf(ScheduleTriggerError);
    await expect(
      webhook.rotateEndpoint({
        workspaceId,
        actorId,
        triggerId: provisioned.webhookId,
        endpointKeyHash: hash(`archived-rotation-${randomUUID()}`),
        idempotencyKey: randomUUID(),
        requestHash: hash(randomUUID()),
      }),
    ).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
    const archiveEvent = await appendReconciliationEvent(
      created.workflowId,
      published.version.id,
    );
    await expect(
      deliverReconciliation(
        created.workflowId,
        published.version.id,
        archiveEvent,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          healthStatus: 'disabled',
          nodeId: 'schedule',
          status: 'disabled',
        }),
        expect.objectContaining({
          endpointReady: true,
          healthStatus: 'disabled',
          nodeId: 'webhook',
          status: 'disabled',
        }),
      ]),
    );
    await expect(workflowState(created.workflowId)).resolves.toMatchObject({
      activation_status: 'inactive',
      lifecycle_status: 'archived',
      published_version_id: published.version.id,
    });
    await expect(immutableWorkflowHistory(created.workflowId)).resolves.toEqual(
      historyBeforeArchive,
    );
    await expect(triggerFacts(created.workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint_status: 'active',
          kind: 'webhook',
          status: 'disabled',
        }),
        expect.objectContaining({
          kind: 'schedule',
          schedule_status: 'enabled',
          status: 'disabled',
        }),
      ]),
    );
  });

  it('migrates from zero, reconciles configuration, and exposes no hashes or secrets in health', async () => {
    await expect(checkDatabaseReadiness(readinessPool)).resolves.toMatchObject({
      migrationHead: '0080_expired_artifact_upload_retention.sql',
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

  it('restores active resources while preserving explicit disablement across worker events', async () => {
    const disabledWorkflow = await publishTriggerWorkflow();
    const disabledStart = await appendReconciliationEvent(
      disabledWorkflow.created.workflowId,
      disabledWorkflow.published.version.id,
    );
    await deliverReconciliation(
      disabledWorkflow.created.workflowId,
      disabledWorkflow.published.version.id,
      disabledStart,
    );
    const disabledResources = await provisionWebhook(
      disabledWorkflow.created.workflowId,
    );
    await schedules.setEnabled({
      workspaceId,
      actorId,
      workflowId: disabledWorkflow.created.workflowId,
      triggerId: disabledResources.scheduleId,
      enabled: false,
      idempotencyKey: randomUUID(),
      requestHash: hash(randomUUID()),
    });
    await workerQuery(
      `update app.webhook_trigger_endpoints set status='disabled',updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2`,
      [workspaceId, disabledResources.endpointId],
    );
    await expect(
      triggerFacts(disabledWorkflow.created.workflowId),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint_id: disabledResources.endpointId,
          endpoint_status: 'disabled',
          kind: 'webhook',
        }),
      ]),
    );
    await setWorkflowLifecycle(
      disabledWorkflow.created.workflowId,
      'archived',
      'deactivating',
    );
    const archiveEvent = await appendReconciliationEvent(
      disabledWorkflow.created.workflowId,
      disabledWorkflow.published.version.id,
    );
    await expect(
      deliverReconciliation(
        disabledWorkflow.created.workflowId,
        disabledWorkflow.published.version.id,
        archiveEvent,
      ),
    ).resolves.toHaveLength(2);
    // Persist while archived, but delay delivery until after restore converges.
    const lateEvent = await appendReconciliationEvent(
      disabledWorkflow.created.workflowId,
      disabledWorkflow.published.version.id,
    );
    await setWorkflowLifecycle(
      disabledWorkflow.created.workflowId,
      'active',
      'activating',
    );
    const restoreEvent = await appendReconciliationEvent(
      disabledWorkflow.created.workflowId,
      disabledWorkflow.published.version.id,
    );
    await expect(
      deliverReconciliation(
        disabledWorkflow.created.workflowId,
        disabledWorkflow.published.version.id,
        restoreEvent,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'schedule', status: 'disabled' }),
        expect.objectContaining({ nodeId: 'webhook', status: 'disabled' }),
      ]),
    );
    await expect(
      deliverReconciliation(
        disabledWorkflow.created.workflowId,
        disabledWorkflow.published.version.id,
        lateEvent,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'schedule', status: 'disabled' }),
        expect.objectContaining({ nodeId: 'webhook', status: 'disabled' }),
      ]),
    );
    await expect(
      deliverReconciliation(
        disabledWorkflow.created.workflowId,
        disabledWorkflow.published.version.id,
        restoreEvent,
      ),
    ).resolves.toEqual([]);
    await expect(
      workflowState(disabledWorkflow.created.workflowId),
    ).resolves.toMatchObject({
      activation_status: 'inactive',
      lifecycle_status: 'active',
    });
    await expect(
      triggerFacts(disabledWorkflow.created.workflowId),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint_status: 'disabled',
          kind: 'webhook',
          status: 'disabled',
        }),
        expect.objectContaining({
          kind: 'schedule',
          schedule_status: 'disabled',
          status: 'disabled',
        }),
      ]),
    );

    const activeWorkflow = await publishTriggerWorkflow();
    const activeStart = await appendReconciliationEvent(
      activeWorkflow.created.workflowId,
      activeWorkflow.published.version.id,
    );
    await deliverReconciliation(
      activeWorkflow.created.workflowId,
      activeWorkflow.published.version.id,
      activeStart,
    );
    await provisionWebhook(activeWorkflow.created.workflowId);
    await setWorkflowLifecycle(
      activeWorkflow.created.workflowId,
      'archived',
      'deactivating',
    );
    const activeArchive = await appendReconciliationEvent(
      activeWorkflow.created.workflowId,
      activeWorkflow.published.version.id,
    );
    await deliverReconciliation(
      activeWorkflow.created.workflowId,
      activeWorkflow.published.version.id,
      activeArchive,
    );
    await setWorkflowLifecycle(
      activeWorkflow.created.workflowId,
      'active',
      'activating',
    );
    const activeRestore = await appendReconciliationEvent(
      activeWorkflow.created.workflowId,
      activeWorkflow.published.version.id,
    );
    await expect(
      deliverReconciliation(
        activeWorkflow.created.workflowId,
        activeWorkflow.published.version.id,
        activeRestore,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'schedule', status: 'active' }),
        expect.objectContaining({
          endpointReady: true,
          nodeId: 'webhook',
          status: 'active',
        }),
      ]),
    );
    await expect(
      workflowState(activeWorkflow.created.workflowId),
    ).resolves.toMatchObject({
      activation_status: 'active',
      lifecycle_status: 'active',
    });
    await expect(
      triggerFacts(activeWorkflow.created.workflowId),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint_status: 'active',
          kind: 'webhook',
          status: 'active',
        }),
        expect.objectContaining({
          kind: 'schedule',
          schedule_status: 'enabled',
          status: 'active',
        }),
      ]),
    );
  });

  it('projects partial, global, and archived failures without overwriting trigger facts', async () => {
    const { created, published } = await publishTriggerWorkflow();
    const start = await appendReconciliationEvent(
      created.workflowId,
      published.version.id,
    );
    await deliverReconciliation(
      created.workflowId,
      published.version.id,
      start,
    );
    const resources = await provisionWebhook(created.workflowId);

    await ownerQuery(
      `update app.workflow_triggers set status='configuration_required',
         health_status='pending',last_error_code=null
         where workspace_id=$1 and id=$2`,
      [workspaceId, resources.scheduleId],
    );
    await reconciliation.recordFailure({
      workspaceId,
      workflowId: created.workflowId,
      publishedVersionId: published.version.id,
      reason: 'provider_partial_failure',
    });
    await expect(triggerFacts(created.workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health_status: 'healthy',
          kind: 'webhook',
          last_error_code: null,
          status: 'active',
        }),
        expect.objectContaining({
          health_status: 'unhealthy',
          kind: 'schedule',
          last_error_code: 'provider_partial_failure',
          status: 'error',
        }),
      ]),
    );
    await expect(workflowState(created.workflowId)).resolves.toMatchObject({
      activation_status: 'degraded',
      lifecycle_status: 'active',
    });

    await ownerQuery(
      `update app.trigger_schedules set status='disabled',health_status='disabled',
         last_error_code=null where workspace_id=$1 and trigger_id=$2`,
      [workspaceId, resources.scheduleId],
    );
    await ownerQuery(
      `update app.workflow_triggers set status='disabled',health_status='disabled',
         last_error_code=null where workspace_id=$1 and id=$2`,
      [workspaceId, resources.scheduleId],
    );
    await reconciliation.recordFailure({
      workspaceId,
      workflowId: created.workflowId,
      publishedVersionId: published.version.id,
      reason: 'provider_disabled_resource',
    });
    await expect(triggerFacts(created.workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health_status: 'healthy',
          kind: 'webhook',
          last_error_code: null,
          status: 'active',
        }),
        expect.objectContaining({
          health_status: 'disabled',
          kind: 'schedule',
          last_error_code: null,
          schedule_health_status: 'disabled',
          schedule_status: 'disabled',
          status: 'disabled',
        }),
      ]),
    );
    await expect(workflowState(created.workflowId)).resolves.toMatchObject({
      activation_status: 'degraded',
    });

    await ownerQuery(
      `update app.workflow_triggers set status='pending',health_status='pending'
         where workspace_id=$1 and id=$2`,
      [workspaceId, resources.webhookId],
    );
    await reconciliation.recordFailure({
      workspaceId,
      workflowId: created.workflowId,
      publishedVersionId: published.version.id,
      reason: 'provider_global_failure',
    });
    await expect(triggerFacts(created.workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health_status: 'unhealthy',
          kind: 'webhook',
          last_error_code: 'provider_global_failure',
          status: 'error',
        }),
        expect.objectContaining({
          health_status: 'disabled',
          kind: 'schedule',
          last_error_code: null,
          status: 'disabled',
        }),
      ]),
    );
    await expect(workflowState(created.workflowId)).resolves.toMatchObject({
      activation_status: 'error',
    });

    await setWorkflowLifecycle(created.workflowId, 'archived', 'deactivating');
    const archiveEvent = await appendReconciliationEvent(
      created.workflowId,
      published.version.id,
    );
    await deliverReconciliation(
      created.workflowId,
      published.version.id,
      archiveEvent,
    );
    await reconciliation.recordFailure({
      workspaceId,
      workflowId: created.workflowId,
      publishedVersionId: published.version.id,
      reason: 'provider_archived_failure',
    });
    await expect(triggerFacts(created.workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health_status: 'disabled',
          kind: 'schedule',
          last_error_code: null,
          status: 'disabled',
        }),
        expect.objectContaining({
          endpoint_status: 'active',
          health_status: 'disabled',
          kind: 'webhook',
          last_error_code: null,
          status: 'disabled',
        }),
      ]),
    );
    await expect(workflowState(created.workflowId)).resolves.toMatchObject({
      activation_status: 'error',
      lifecycle_status: 'archived',
    });
  });

  it('rejects an old-version event without rewriting current health or history', async () => {
    const first = await publishTriggerWorkflow();
    await reconciliation.reconcile({
      workspaceId,
      workflowId: first.created.workflowId,
      publishedVersionId: first.published.version.id,
      outboxEventId: first.eventId,
    });
    const firstResources = await provisionWebhook(first.created.workflowId);
    await expect(
      webhook.resolveVerification(firstResources.endpointKeyHash),
    ).resolves.not.toBeNull();
    const second = await publishNextTriggerWorkflowVersion(
      first.created.workflowId,
    );
    const latestHealth = await reconciliation.reconcile({
      workspaceId,
      workflowId: first.created.workflowId,
      publishedVersionId: second.published.version.id,
      outboxEventId: second.eventId,
    });
    const historyBeforeStaleDelivery = await immutableWorkflowHistory(
      first.created.workflowId,
    );
    await expect(
      reconciliation.reconcile({
        workspaceId,
        workflowId: first.created.workflowId,
        publishedVersionId: first.published.version.id,
        outboxEventId: first.eventId,
        delivery: {
          outboxEventId: first.eventId,
          payloadChecksum: first.eventChecksum,
        },
      }),
    ).rejects.toBeInstanceOf(WorkflowTriggerStalePublicationError);
    await expect(
      webhook.getHealth({
        workspaceId,
        actorId,
        workflowId: first.created.workflowId,
      }),
    ).resolves.toEqual(latestHealth);
    await expect(
      immutableWorkflowHistory(first.created.workflowId),
    ).resolves.toEqual(historyBeforeStaleDelivery);
    await expect(
      workflowState(first.created.workflowId),
    ).resolves.toMatchObject({
      lifecycle_status: 'active',
      published_version_id: second.published.version.id,
    });
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
