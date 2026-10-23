import { createHash, randomUUID } from 'node:crypto';
import type { WebhookRequest } from '@pertexo/nodes-core';
import { Pool, type QueryResultRow } from 'pg';

import { parseDatabaseConfig } from '../../../src/config.js';
import { createIdentityWorkspaceDatabase } from '../../../src/tenant-access/database.js';
import { migrateDatabase } from '../../../src/migrations.js';
import { canonicalOutboxPayloadChecksum } from '../../../src/outbox/events.js';
import type { WorkflowAuthoringDatabase } from '../../../src/authoring/workflows/database.js';
import { createWorkflowAuthoringFixtureDatabase as createWorkflowAuthoringDatabase } from '../../support/workflow-authoring-admission.fixture.js';
import {
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';

import { createWebhookTriggerDatabase } from '../../../src/triggers/webhooks/database.js';
import { createWorkflowTriggerReconciliationDatabase } from '../../../src/triggers/reconciliation/database.js';
import { createScheduleTriggerDatabase } from '../../../src/triggers/schedules/database.js';

import { dropDisconnectedDatabase } from '../../support/postgres/disposable-database.js';
import { withWorkspaceTransaction } from '../../../src/tenant-access/transactions.js';
import { claimedScheduleWorkflowPaused } from '../../../src/triggers/schedules/pause.js';

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

export const databaseName = `pertexo_test_webhook_${randomUUID().replaceAll('-', '')}`;

export const url = (base: string): string => {
  const parsed = new URL(base);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
};

export const actorId = randomUUID();

export const workspaceId = randomUUID();

export const workflowId = randomUUID();

export const versionId = randomUUID();

export const triggerId = randomUUID();

export const endpointId = randomUUID();

export const outboxEventId = randomUUID();

const notificationConnectionId = randomUUID();

export const notificationSecretVersionId = randomUUID();

export const notificationDestinationId = randomUUID();

export const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const endpointHash = hash('endpoint-one');

export const secret = (id = randomUUID()) => ({
  id,
  kmsKeyReference: 'kms://test/webhook',
  encryptedDataKey: `encrypted-key-${id}`,
  ciphertext: `ciphertext-${id}`,
  nonce: 'nonce-value',
  authTag: 'authentication-tag',
});

const migrationConfig = {
  connectionString: url(migrationBaseUrl),
  ownerRole: 'pertexo_owner',
  appRole: 'pertexo_app',
  maintenanceRole: 'pertexo_maintenance',
} as const;

export const apiConfig = parseDatabaseConfig({
  connectionString: url(apiBaseUrl),
  max: 8,
});

const workerConfig = parseDatabaseConfig({
  connectionString: url(workerBaseUrl),
  max: 8,
});

export const post = (body: unknown): WebhookRequest => ({
  method: 'POST',
  body,
  query: {},
  headers: {},
});

export async function acceptWebhook(
  input: Parameters<
    ReturnType<typeof createWebhookTriggerDatabase>['acceptVerifiedDelivery']
  >[0],
) {
  const result = await webhook.acceptVerifiedDelivery(input);
  if (!('runId' in result))
    throw new Error('Expected an accepted webhook in this journey');
  return result;
}

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

const triggerCatalog = Object.freeze({
  definitions: Object.freeze([
    Object.freeze({ key: 'core.webhook', version: 1 }),
    Object.freeze({ key: 'core.schedule', version: 1 }),
  ]),
});

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

export /** Whether a claimed schedule's workflow is paused now. */
function pausedNow(
  claim: Readonly<{ trigger_id: string; lease_token: string }>,
) {
  return withWorkspaceTransaction(workerPool, workspaceId, (transaction) =>
    claimedScheduleWorkflowPaused(transaction, claim, new Date()),
  );
}

export async function workerQuery<Row extends QueryResultRow = QueryResultRow>(
  statement: string,
  parameters: unknown[] = [],
) {
  const client = await workerPool.connect();
  let releaseClient = (): void => {
    client.release();
  };
  try {
    await client.query('begin');
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
          new Error('Webhook fixture worker rollback failed', {
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

export async function apiQuery<Row extends QueryResultRow = QueryResultRow>(
  statement: string,
  parameters: unknown[] = [],
) {
  const client = await readinessPool.connect();
  let releaseClient = (): void => {
    client.release();
  };
  try {
    await client.query('begin');
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
          new Error('Webhook fixture API rollback failed', {
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

export const checkpointFactory = (projection?: { id: string }) => ({
  checkpoint: {
    workflowVersionId: projection?.id ?? versionId,
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
  },
});

function triggerGraph(intervalMinutes = 15, graphDisabled = false) {
  return {
    settings: {},
    nodes: [
      {
        id: 'webhook',
        disabled: graphDisabled,
        definition: { key: 'core.webhook', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'schedule',
        disabled: graphDisabled,
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

export async function workflowTriggerIds(workflowIdInput: string) {
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

export async function appendReconciliationEvent(
  workflowIdInput: string,
  versionIdInput: string,
) {
  const eventId = randomUUID();
  const payload = {
    workspaceId,
    outboxEventId: eventId,
    workflowId: workflowIdInput,
    publishedVersionId: versionIdInput,
  };
  const payloadChecksum = canonicalOutboxPayloadChecksum(payload);
  await ownerQuery(
    `insert into app.outbox_events(id,workspace_id,job_name,
         aggregate_type,aggregate_id,payload,payload_checksum)
       values($1,$2,'reconcile-workflow-triggers','workflow',$3,$4::jsonb,$5)`,
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

export async function deliverReconciliation(
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

export async function setWorkflowLifecycle(
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

export async function immutableWorkflowHistory(workflowIdInput: string) {
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

export async function publishTriggerWorkflow(
  graphDisabled = false,
  responseConfig: Record<string, unknown> = {},
) {
  const created = await authoring.createWorkflow({
    actorId,
    workspaceId,
    name: 'Published trigger projection',
    emptyGraph: { settings: {}, nodes: [], edges: [] },
    idempotencyKey: randomUUID(),
  });
  const graph = triggerGraph(15, graphDisabled);
  const webhookNode = graph.nodes.find(
    (node) => node.definition.key === 'core.webhook',
  );
  if (webhookNode === undefined) throw new Error('Webhook fixture missing');
  webhookNode.config = responseConfig;
  const draft = await authoring.saveDraft({
    actorId,
    workspaceId,
    workflowId: created.workflowId,
    representationTag: workflowDraftRepresentationTag({
      workflowId: created.workflowId,
      revision: created.draft.revision,
      graph: created.draft.graphJson,
      compatibilityFingerprint: created.draft.compatibility.fingerprint,
    }),
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

export async function publishNextTriggerWorkflowVersion(
  workflowIdInput: string,
) {
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
    representationTag: workflowDraftRepresentationTag({
      workflowId: workflowIdInput,
      revision: currentDraft.revision,
      graph: currentDraft.graphJson,
      compatibilityFingerprint: currentDraft.compatibility.fingerprint,
    }),
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
  if (row === undefined) throw new Error('Latest reconciliation event missing');
  return Object.freeze({
    eventChecksum: row.payload_checksum,
    eventId: row.id,
    published,
  });
}

export async function provisionWebhook(workflowIdInput: string) {
  const ids = await workflowTriggerIds(workflowIdInput);
  const endpointKeyHash = hash(`endpoint-${randomUUID()}`);
  const endpointId = randomUUID();
  const health = await webhook.provision({
    workspaceId,
    workflowId: workflowIdInput,
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

export async function createWebhookScenario(
  responseConfig: Record<string, unknown> = {},
) {
  const published = await publishTriggerWorkflow(false, responseConfig);
  await ownerQuery(
    `insert into app.workflow_failure_notification_policies
         (workspace_id,workflow_id,destination_id,updated_by)
       values($1,$2,$3,$4)`,
    [
      workspaceId,
      published.created.workflowId,
      notificationDestinationId,
      actorId,
    ],
  );
  await deliverReconciliation(
    published.created.workflowId,
    published.published.version.id,
    {
      eventId: published.eventId,
      payloadChecksum: published.eventChecksum,
    },
  );
  const resources = await provisionWebhook(published.created.workflowId);
  const verification = await webhook.resolveVerification(
    resources.endpointKeyHash,
  );
  if (verification === null)
    throw new Error('Expected scenario endpoint resolution');
  return Object.freeze({ published, resources, verification });
}

export async function triggerFacts(workflowIdInput: string) {
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

export async function workflowState(workflowIdInput: string) {
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
  webhook = createWebhookTriggerDatabase(apiConfig);
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
