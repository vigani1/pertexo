import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  createIdentityWorkspaceDatabase,
  createOutboxDispatcherDatabase,
  createPublishedWorkflowReader,
  createWorkflowAuthoringDatabase,
  createWorkflowTriggerReconciliationDatabase,
  migrateDatabase,
  parseDatabaseConfig,
  type DatabaseConfig,
  type IdentityWorkspaceDatabase,
  type WorkflowAuthoringDatabase,
} from '@pertexo/database/testing';
import {
  createQueueProducer,
  JOB_NAME,
  jobIdForOutboxEvent,
  QUEUE_NAME,
  type QueueConsumer,
} from '@pertexo/queue';
import { Queue } from 'bullmq';
import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from 'pg';

import { dropDisconnectedDatabase } from './disposable-database.js';
import { WorkerDrainState } from '../../src/runtime/worker-drain-state.js';
import {
  createDispatchConsumerCapabilityRegistry,
  type DispatchConsumerCapabilityRegistry,
} from '../../src/transport/dispatch-consumer-capabilities.js';
import { OutboxDispatcher } from '../../src/transport/outbox-dispatcher.js';
import {
  createTriggerRuntime,
  type TriggerRuntime,
} from '../../src/triggers/trigger-runtime.js';

const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';
const apiRole = process.env.POSTGRES_API_RUNTIME_USER ?? 'pertexo_api';
const workerRole = process.env.POSTGRES_WORKER_RUNTIME_USER ?? 'pertexo_worker';
const dispatcherRole =
  process.env.POSTGRES_DISPATCHER_RUNTIME_USER ?? 'pertexo_dispatcher';
const migrationRole =
  process.env.POSTGRES_MIGRATION_USER ?? 'pertexo_migration';
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
const dispatcherBaseUrl =
  process.env.DATABASE_DISPATCHER_URL ??
  'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo';
const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';

const baselineMigration = readFileSync(
  new URL(
    '../../../../packages/database/migrations/0017_node_compatibility_releases.sql',
    import.meta.url,
  ),
  'utf8',
);
const baselineCatalogMatch = /\$catalog\$([\s\S]+?)\$catalog\$::jsonb/u.exec(
  baselineMigration,
);
if (baselineCatalogMatch?.[1] === undefined)
  throw new Error('Worker lifecycle baseline compatibility catalog is missing');
const baselineCompatibilityExpectation = Object.freeze({
  epoch: 1,
  fingerprint:
    'node-compat:v1:sha256:cf21b2e644563beb8b031481e9d5182b361b4ae2d4abd1d7d86d7b3fe0299f59',
  catalogJson: JSON.stringify(JSON.parse(baselineCatalogMatch[1]) as unknown),
});

/** This file owns Redis database 15; neighboring trigger tests use 13 and 14. */
export const workflowLifecycleIntegrationRedisUrl = (() => {
  const parsed = new URL(configuredRedisUrl);
  parsed.pathname = '/15';
  return parsed.toString();
})();

export const workflowLifecycleIntegrationEnabled =
  process.env.WORKER_TRIGGER_INTEGRATION === 'true';

const lifecycleRunKeys = ['queued', 'running', 'waiting', 'succeeded'] as const;

export type LifecycleRunKey = (typeof lifecycleRunKeys)[number];

export type LifecycleIds = Readonly<{
  workflow: string;
  version: string;
  activeWebhook: string;
  activeSchedule: string;
  disabledWebhook: string;
  disabledSchedule: string;
  activeWebhookEndpoint: string;
  disabledWebhookEndpoint: string;
  activeWebhookSecret: string;
  disabledWebhookSecret: string;
  runs: Readonly<Record<LifecycleRunKey, string>>;
}>;

export type LifecycleProjection = Readonly<{
  workflow: Readonly<{
    lifecycleStatus: string;
    lifecycleRevision: number;
    activationStatus: string;
    publishedVersionId: string | null;
  }>;
  triggers: readonly Readonly<{
    id: string;
    kind: string;
    status: string;
    healthStatus: string;
    configFingerprint: string;
  }>[];
  endpoints: readonly Readonly<{
    id: string;
    triggerId: string;
    status: string;
  }>[];
  schedules: readonly Readonly<{
    triggerId: string;
    status: string;
    healthStatus: string;
    configFingerprint: string;
  }>[];
}>;

export type RunSnapshot = Readonly<{
  runs: Readonly<Record<LifecycleRunKey, string>>;
  events: Readonly<Record<LifecycleRunKey, readonly string[]>>;
  checkpoints: Readonly<Record<LifecycleRunKey, string>>;
}>;

export type LifecycleOutboxEvent = Readonly<{
  id: string;
  payload: Readonly<{
    schemaVersion: 1;
    workspaceId: string;
    workflowId: string;
    publishedVersionId: string;
    outboxEventId: string;
  }>;
}>;

type Closeable = Readonly<{ close(): Promise<unknown> }>;

export type WorkflowLifecycleWorkerEnvironment = Readonly<{
  apiConfig: DatabaseConfig;
  workerConfig: DatabaseConfig;
  dispatcherConfig: DatabaseConfig;
  actorId: string;
  workspaceId: string;
  ids: LifecycleIds;
  authoring: WorkflowAuthoringDatabase;
  queue: Queue;
  initialize(): Promise<void>;
  ownerQuery<Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  workerQuery<Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  transition(
    command: 'archive' | 'restore',
    expectedLifecycleRevision: number,
    idempotencyKey: string,
  ): ReturnType<WorkflowAuthoringDatabase['transitionWorkflowLifecycle']>;
  readProjection(): Promise<LifecycleProjection>;
  readRunSnapshot(): Promise<RunSnapshot>;
  readOutboxEvent(id: string): Promise<LifecycleOutboxEvent>;
  makeDue(id: string): Promise<void>;
  createRuntime(leaseOwner: string): Promise<TriggerRuntime>;
  createDispatcher(
    leaseOwner: string,
    capabilities: DispatchConsumerCapabilityRegistry,
  ): OutboxDispatcher;
  readyCapabilities(): DispatchConsumerCapabilityRegistry;
  close(): Promise<void>;
}>;

function databaseUrl(baseUrl: string, databaseName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function bullConnection(redisUrl: string): {
  db: number;
  host: string;
  password?: string;
  port: number;
} {
  const parsed = new URL(redisUrl);
  return {
    db: Number(parsed.pathname.slice(1) || '0'),
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password === ''
      ? {}
      : { password: decodeURIComponent(parsed.password) }),
  };
}

async function withTransaction<T>(
  pool: Pool,
  workspaceId: string,
  operation: (client: PoolClient) => Promise<T>,
  role?: string,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (role !== undefined)
      await client.query(`set local role ${quoteIdentifier(role)}`);
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function noOpScanner() {
  return {
    close: (): Promise<void> => Promise.resolve(),
    scanDue: (): Promise<{
      claimed: 0;
      accepted: 0;
      skipped: 0;
      deferred: 0;
      maxLagSeconds: 0;
    }> =>
      Promise.resolve({
        claimed: 0,
        accepted: 0,
        skipped: 0,
        deferred: 0,
        maxLagSeconds: 0,
      }),
  };
}

async function seedWorkflowRows(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  ids: LifecycleIds,
): Promise<void> {
  const graph = {
    schemaVersion: 1,
    settings: { proof: 'workflow-lifecycle' },
    nodes: [],
    edges: [],
  };
  const executable = {
    schemaVersion: 2,
    compatibilityReleaseEpoch: 1,
    nodes: [],
    edges: [],
  };
  const workflowFingerprint = `wf:v2:sha256:${'c'.repeat(64)}`;
  const activeWebhookFingerprint = `trigger:v1:sha256:${'1'.repeat(64)}`;
  const activeScheduleFingerprint = `trigger:v1:sha256:${'2'.repeat(64)}`;
  const disabledWebhookFingerprint = `trigger:v1:sha256:${'3'.repeat(64)}`;
  const disabledScheduleFingerprint = `trigger:v1:sha256:${'4'.repeat(64)}`;
  const activeScheduleConfig = {
    kind: 'interval',
    intervalMinutes: 60,
    misfirePolicy: 'catch_up_once',
  };
  const disabledScheduleConfig = {
    kind: 'interval',
    intervalMinutes: 120,
    misfirePolicy: 'skip',
  };

  await client.query(
    `insert into app.workflows
       (id,workspace_id,name,lifecycle_status,activation_status,lifecycle_revision,
        published_version_id,created_by)
     values ($1,$2,'Worker lifecycle proof','active','active',1,null,$3)`,
    [ids.workflow, workspaceId, actorId],
  );
  await client.query(
    `insert into app.workflow_drafts
       (workflow_id,workspace_id,revision,schema_version,graph_json,updated_by)
     values ($1,$2,17,1,$3::jsonb,$4)`,
    [ids.workflow, workspaceId, JSON.stringify(graph), actorId],
  );
  await client.query(
    `insert into app.workflow_versions
       (id,workspace_id,workflow_id,version_number,schema_version,graph_json,
        checksum,published_by,executable_schema_version,executable_json,
        compatibility_release_epoch)
     values ($1,$2,$3,3,1,$4::jsonb,$5,$6,2,$7::jsonb,1)`,
    [
      ids.version,
      workspaceId,
      ids.workflow,
      JSON.stringify(graph),
      workflowFingerprint,
      actorId,
      JSON.stringify(executable),
    ],
  );
  await client.query(
    `update app.workflows set published_version_id=$2 where id=$1`,
    [ids.workflow, ids.version],
  );

  await client.query(
    `insert into app.workflow_triggers
       (id,workspace_id,workflow_id,workflow_version_id,node_id,kind,status,
        desired_config,config_fingerprint,health_status)
     values
       ($1,$2,$3,$4,'active-webhook','webhook','active','{}'::jsonb,$5,'healthy'),
       ($6,$2,$3,$4,'active-schedule','schedule','active',$7::jsonb,$8,'healthy'),
       ($9,$2,$3,$4,'disabled-webhook','webhook','disabled','{}'::jsonb,$10,'disabled'),
       ($11,$2,$3,$4,'disabled-schedule','schedule','disabled',$12::jsonb,$13,'disabled')`,
    [
      ids.activeWebhook,
      workspaceId,
      ids.workflow,
      ids.version,
      activeWebhookFingerprint,
      ids.activeSchedule,
      JSON.stringify(activeScheduleConfig),
      activeScheduleFingerprint,
      ids.disabledWebhook,
      disabledWebhookFingerprint,
      ids.disabledSchedule,
      JSON.stringify(disabledScheduleConfig),
      disabledScheduleFingerprint,
    ],
  );
  await client.query(
    `insert into app.trigger_schedules
       (trigger_id,workspace_id,recurrence_kind,interval_minutes,misfire_policy,
        config_fingerprint,anchor_at,next_fire_at,status,health_status)
     values
       ($1,$2,'interval',60,'catch_up_once',$3,clock_timestamp()+interval '1 hour',
        clock_timestamp()+interval '2 hours','enabled','healthy'),
       ($4,$2,'interval',120,'skip',$5,clock_timestamp()+interval '1 hour',
        clock_timestamp()+interval '3 hours','disabled','disabled')`,
    [
      ids.activeSchedule,
      workspaceId,
      activeScheduleFingerprint,
      ids.disabledSchedule,
      disabledScheduleFingerprint,
    ],
  );
}

async function seedApiOwnedRows(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  ids: LifecycleIds,
): Promise<void> {
  for (const [secretId, triggerId] of [
    [ids.activeWebhookSecret, ids.activeWebhook] as const,
    [ids.disabledWebhookSecret, ids.disabledWebhook] as const,
  ]) {
    await client.query(
      `insert into app.webhook_trigger_secret_versions
         (id,workspace_id,trigger_id,schema_version,kms_key_reference,
          encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
       values ($1,$2,$3,1,'worker-lifecycle-kms','worker-lifecycle-key',
               'worker-lifecycle-cipher','worker-lifecycle-nonce',
               'worker-lifecycle-auth-tag',$4)`,
      [secretId, workspaceId, triggerId, actorId],
    );
  }
  await client.query(
    `insert into app.webhook_trigger_endpoints
       (id,workspace_id,trigger_id,endpoint_key_hash,status,current_secret_version_id)
     values
       ($1,$2,$3,$4,'active',$5),
       ($6,$2,$7,$8,'disabled',$9)`,
    [
      ids.activeWebhookEndpoint,
      workspaceId,
      ids.activeWebhook,
      'a'.repeat(64),
      ids.activeWebhookSecret,
      ids.disabledWebhookEndpoint,
      ids.disabledWebhook,
      'b'.repeat(64),
      ids.disabledWebhookSecret,
    ],
  );
  await client.query(
    `insert into app.workflow_runs
       (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
        started_at,completed_at,output_ref)
     values
       ($1,$2,$3,$4,'manual','queued',NULL,NULL,NULL),
       ($5,$2,$3,$4,'manual','running',
        clock_timestamp()-interval '8 minutes',NULL,NULL),
       ($6,$2,$3,$4,'manual','waiting',
        clock_timestamp()-interval '7 minutes',NULL,NULL),
       ($7,$2,$3,$4,'manual','succeeded',
        clock_timestamp()-interval '10 minutes',
        clock_timestamp()-interval '9 minutes',
        '{"prior":true,"preserved":"lifecycle","status":"succeeded"}'::jsonb)`,
    [
      ids.runs.queued,
      workspaceId,
      ids.workflow,
      ids.version,
      ids.runs.running,
      ids.runs.waiting,
      ids.runs.succeeded,
    ],
  );
  await client.query(
    `insert into app.run_events
       (workspace_id,workflow_run_id,sequence,type,payload)
     values
       ($1,$2,1,'run.queued','{"runStatus":"queued","proof":"lifecycle"}'::jsonb),
       ($1,$3,1,'run.queued','{"runStatus":"running","proof":"lifecycle"}'::jsonb),
       ($1,$3,2,'run.started','{"runStatus":"running","proof":"lifecycle"}'::jsonb),
       ($1,$4,1,'run.queued','{"runStatus":"waiting","proof":"lifecycle"}'::jsonb),
       ($1,$4,2,'run.started','{"runStatus":"waiting","proof":"lifecycle"}'::jsonb),
       ($1,$4,3,'run.waiting','{"runStatus":"waiting","proof":"lifecycle"}'::jsonb),
       ($1,$5,1,'run.queued','{"runStatus":"succeeded","proof":"lifecycle"}'::jsonb),
       ($1,$5,2,'run.started','{"runStatus":"succeeded","proof":"lifecycle"}'::jsonb),
       ($1,$5,3,'run.succeeded','{"runStatus":"succeeded","proof":"lifecycle"}'::jsonb)`,
    [
      workspaceId,
      ids.runs.queued,
      ids.runs.running,
      ids.runs.waiting,
      ids.runs.succeeded,
    ],
  );
  await client.query(
    `insert into app.run_checkpoints
       (workflow_run_id,workspace_id,revision,engine_version,scheduler_state,
        resume_at,workflow_version_id,last_transition_fingerprint)
     values
       ($1,$2,1,'worker-lifecycle-proof',
        '{"runStatus":"queued","nextEventSequence":2,"proof":"lifecycle"}'::jsonb,
        NULL,$6,$7),
       ($3,$2,2,'worker-lifecycle-proof',
        '{"runStatus":"running","nextEventSequence":3,"proof":"lifecycle"}'::jsonb,
        NULL,$6,$8),
       ($4,$2,3,'worker-lifecycle-proof',
        '{"runStatus":"waiting","nextEventSequence":4,"proof":"lifecycle"}'::jsonb,
        clock_timestamp()+interval '1 hour',$6,$9),
       ($5,$2,4,'worker-lifecycle-proof',
        '{"runStatus":"succeeded","nextEventSequence":4,"proof":"lifecycle"}'::jsonb,
        NULL,$6,$10)`,
    [
      ids.runs.queued,
      workspaceId,
      ids.runs.running,
      ids.runs.waiting,
      ids.runs.succeeded,
      ids.version,
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
    ],
  );
}

export function createWorkflowLifecycleWorkerEnvironment(): WorkflowLifecycleWorkerEnvironment {
  const databaseName = `pertexo_test_worker_lifecycle_${randomUUID().replaceAll('-', '')}`;
  const apiConfig = parseDatabaseConfig({
    connectionString: databaseUrl(apiBaseUrl, databaseName),
    max: 8,
  });
  const workerConfig = parseDatabaseConfig({
    connectionString: databaseUrl(workerBaseUrl, databaseName),
    max: 8,
  });
  const dispatcherConfig = parseDatabaseConfig({
    connectionString: databaseUrl(dispatcherBaseUrl, databaseName),
    max: 2,
  });
  const migrationUrl = databaseUrl(migrationBaseUrl, databaseName);
  const workspaceId = randomUUID();
  const actorId = randomUUID();
  const ids = {
    workflow: randomUUID(),
    version: randomUUID(),
    activeWebhook: randomUUID(),
    activeSchedule: randomUUID(),
    disabledWebhook: randomUUID(),
    disabledSchedule: randomUUID(),
    activeWebhookEndpoint: randomUUID(),
    disabledWebhookEndpoint: randomUUID(),
    activeWebhookSecret: randomUUID(),
    disabledWebhookSecret: randomUUID(),
    runs: {
      queued: randomUUID(),
      running: randomUUID(),
      waiting: randomUUID(),
      succeeded: randomUUID(),
    },
  } as const;
  const owner = new Pool({ connectionString: migrationUrl, max: 2 });
  const apiPool = new Pool({
    connectionString: apiConfig.connectionString,
    max: 2,
  });
  const worker = new Pool({
    connectionString: workerConfig.connectionString,
    max: 2,
  });
  const identity: IdentityWorkspaceDatabase =
    createIdentityWorkspaceDatabase(apiConfig);
  const authoring = createWorkflowAuthoringDatabase(apiConfig);
  const queue = new Queue(QUEUE_NAME.triggerLifecycle, {
    connection: bullConnection(workflowLifecycleIntegrationRedisUrl),
  });
  const resources: Closeable[] = [authoring, identity];
  let initialized = false;

  const ownerQuery = async <Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> =>
    withTransaction<QueryResult<Row>>(
      owner,
      workspaceId,
      async (client) => {
        return client.query<Row>(statement, [...parameters]);
      },
      ownerRole,
    );

  const workerQuery = async <Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> =>
    withTransaction<QueryResult<Row>>(worker, workspaceId, (client) =>
      client.query<Row>(statement, [...parameters]),
    );

  const initialize = async (): Promise<void> => {
    if (initialized) return;
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await admin.query(
        `create database ${quoteIdentifier(databaseName)} owner ${quoteIdentifier(ownerRole)}`,
      );
      await admin.query(
        `revoke all on database ${quoteIdentifier(databaseName)} from public`,
      );
      await admin.query(
        `grant connect on database ${quoteIdentifier(databaseName)} to ${[
          migrationRole,
          apiRole,
          workerRole,
          dispatcherRole,
        ]
          .map(quoteIdentifier)
          .join(',')}`,
      );
    } finally {
      await admin.end();
    }
    await migrateDatabase({
      connectionString: migrationUrl,
      ownerRole,
      apiRuntimeRole: apiRole,
      workerRuntimeRole: workerRole,
      dispatcherRole,
      maintenanceRole:
        process.env.POSTGRES_MAINTENANCE_USER ?? 'pertexo_maintenance',
      lifecycleCommandRole:
        process.env.POSTGRES_LIFECYCLE_COMMAND_USER ??
        'pertexo_lifecycle_command',
      operatorRole: process.env.POSTGRES_OPERATOR_USER ?? 'pertexo_operator',
    });
    await identity.createUser({
      id: actorId,
      email: `worker-lifecycle-${actorId}@example.test`,
      displayName: 'Worker lifecycle owner',
    });
    await identity.createWorkspaceWithOwner({
      id: workspaceId,
      name: 'Worker lifecycle workspace',
      slug: `worker-lifecycle-${actorId}`,
      ownerUserId: actorId,
      idempotencyKey: `worker-lifecycle-${actorId}`,
    });
    await withTransaction(
      owner,
      workspaceId,
      (client) => seedWorkflowRows(client, workspaceId, actorId, ids),
      ownerRole,
    );
    await withTransaction(apiPool, workspaceId, (client) =>
      seedApiOwnedRows(client, workspaceId, actorId, ids),
    );
    initialized = true;
    await queue.obliterate({ force: true });
  };

  const readProjection = async (): Promise<LifecycleProjection> =>
    withTransaction(
      owner,
      workspaceId,
      async (client) => {
        const workflow = await client.query<{
          lifecycle_status: string;
          lifecycle_revision: number;
          activation_status: string;
          published_version_id: string | null;
        }>(
          `select lifecycle_status,lifecycle_revision,activation_status,published_version_id
           from app.workflows where id=$1`,
          [ids.workflow],
        );
        const triggers = await client.query<{
          id: string;
          kind: string;
          status: string;
          health_status: string;
          config_fingerprint: string;
        }>(
          `select id,kind,status,health_status,config_fingerprint
           from app.workflow_triggers where workflow_id=$1 order by id`,
          [ids.workflow],
        );
        const endpoints = await client.query<{
          id: string;
          trigger_id: string;
          status: string;
        }>(
          `select id,trigger_id,status from app.webhook_trigger_endpoints
           where workspace_id=$1 order by id`,
          [workspaceId],
        );
        const schedules = await client.query<{
          trigger_id: string;
          status: string;
          health_status: string;
          config_fingerprint: string;
        }>(
          `select trigger_id,status,health_status,config_fingerprint
           from app.trigger_schedules where workspace_id=$1 order by trigger_id`,
          [workspaceId],
        );
        const workflowRow = workflow.rows[0];
        if (workflowRow === undefined)
          throw new Error('Workflow projection missing');
        return {
          workflow: {
            lifecycleStatus: workflowRow.lifecycle_status,
            lifecycleRevision: workflowRow.lifecycle_revision,
            activationStatus: workflowRow.activation_status,
            publishedVersionId: workflowRow.published_version_id,
          },
          triggers: triggers.rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            status: row.status,
            healthStatus: row.health_status,
            configFingerprint: row.config_fingerprint,
          })),
          endpoints: endpoints.rows.map((row) => ({
            id: row.id,
            triggerId: row.trigger_id,
            status: row.status,
          })),
          schedules: schedules.rows.map((row) => ({
            triggerId: row.trigger_id,
            status: row.status,
            healthStatus: row.health_status,
            configFingerprint: row.config_fingerprint,
          })),
        };
      },
      ownerRole,
    );

  const readRunSnapshot = async (): Promise<RunSnapshot> =>
    withTransaction(worker, workspaceId, async (client) => {
      const runIds = lifecycleRunKeys.map((key) => ids.runs[key]);
      const runs = await client.query<{ id: string; value: string }>(
        `select id,row_to_json(run)::text as value
             from app.workflow_runs run
            where workspace_id=$1 and id=any($2::uuid[])
            order by id`,
        [workspaceId, runIds],
      );
      const events = await client.query<{
        workflow_run_id: string;
        value: string;
      }>(
        `select workflow_run_id,row_to_json(event)::text as value
             from app.run_events event
            where workspace_id=$1 and workflow_run_id=any($2::uuid[])
            order by workflow_run_id,sequence`,
        [workspaceId, runIds],
      );
      const checkpoints = await client.query<{
        workflow_run_id: string;
        value: string;
      }>(
        `select workflow_run_id,row_to_json(checkpoint)::text as value
             from app.run_checkpoints checkpoint
            where workspace_id=$1 and workflow_run_id=any($2::uuid[])
            order by workflow_run_id`,
        [workspaceId, runIds],
      );

      const runValues = new Map(
        runs.rows.map((row) => [row.id, row.value] as const),
      );
      const eventValues = new Map<string, string[]>();
      for (const row of events.rows) {
        const values = eventValues.get(row.workflow_run_id) ?? [];
        values.push(row.value);
        eventValues.set(row.workflow_run_id, values);
      }
      const checkpointValues = new Map(
        checkpoints.rows.map(
          (row) => [row.workflow_run_id, row.value] as const,
        ),
      );
      const runAt = (key: LifecycleRunKey): string => {
        const value = runValues.get(ids.runs[key]);
        if (value === undefined)
          throw new Error(`Run ${key} is missing from worker projection`);
        return value;
      };
      const eventsAt = (key: LifecycleRunKey): readonly string[] => {
        const values = eventValues.get(ids.runs[key]);
        if (values === undefined || values.length === 0)
          throw new Error(
            `Run ${key} events are missing from worker projection`,
          );
        return Object.freeze([...values]);
      };
      const checkpointAt = (key: LifecycleRunKey): string => {
        const value = checkpointValues.get(ids.runs[key]);
        if (value === undefined)
          throw new Error(
            `Run ${key} checkpoint is missing from worker projection`,
          );
        return value;
      };
      return Object.freeze({
        runs: Object.freeze({
          queued: runAt('queued'),
          running: runAt('running'),
          waiting: runAt('waiting'),
          succeeded: runAt('succeeded'),
        }),
        events: Object.freeze({
          queued: eventsAt('queued'),
          running: eventsAt('running'),
          waiting: eventsAt('waiting'),
          succeeded: eventsAt('succeeded'),
        }),
        checkpoints: Object.freeze({
          queued: checkpointAt('queued'),
          running: checkpointAt('running'),
          waiting: checkpointAt('waiting'),
          succeeded: checkpointAt('succeeded'),
        }),
      });
    });

  const readOutboxEvent = async (id: string): Promise<LifecycleOutboxEvent> =>
    withTransaction(
      owner,
      workspaceId,
      async (client) => {
        const result = await client.query<{
          id: string;
          payload: LifecycleOutboxEvent['payload'];
        }>(
          `select id,payload from app.outbox_events where id=$1 and job_name=$2`,
          [id, JOB_NAME.reconcileWorkflowTriggers],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error(`Outbox event ${id} is missing`);
        return row;
      },
      ownerRole,
    );

  const createRuntime = async (leaseOwner: string): Promise<TriggerRuntime> => {
    const reader = createPublishedWorkflowReader(
      workerConfig,
      baselineCompatibilityExpectation,
    );
    const reconciliation =
      createWorkflowTriggerReconciliationDatabase(workerConfig);
    const runtime = await createTriggerRuntime(
      {
        batchSize: 10,
        database: workerConfig,
        leaseDurationSeconds: 5,
        leaseOwner,
        pollIntervalMillis: 25,
        redisUrl: workflowLifecycleIntegrationRedisUrl,
        releaseCohort: 'core',
      },
      { reader, reconciliation, scanner: noOpScanner() },
    );
    resources.push(runtime);
    await runtime.consumer.waitUntilReady(5_000);
    return runtime;
  };

  const readyCapabilities = () =>
    createDispatchConsumerCapabilityRegistry([
      {
        jobName: JOB_NAME.reconcileWorkflowTriggers,
        consumer: {
          isReady: () => true,
          waitUntilReady: () => Promise.resolve(),
        },
      },
    ]);

  const createDispatcher = (
    leaseOwner: string,
    capabilities: DispatchConsumerCapabilityRegistry,
  ): OutboxDispatcher => {
    const dispatcher = new OutboxDispatcher(
      createOutboxDispatcherDatabase(dispatcherConfig),
      createQueueProducer({ redisUrl: workflowLifecycleIntegrationRedisUrl }),
      new WorkerDrainState(),
      {
        batchSize: 10,
        enabledJobNames: [JOB_NAME.reconcileWorkflowTriggers],
        leaseDurationMillis: 1_000,
        leaseOwner,
        maxAttempts: 3,
        operationTimeoutMillis: 5_000,
        retryDelayMillis: 10,
      },
      undefined,
      capabilities,
    );
    resources.push(dispatcher);
    return dispatcher;
  };

  const close = async (): Promise<void> => {
    await Promise.allSettled(
      resources
        .splice(0)
        .reverse()
        .map((resource) => resource.close()),
    );
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await Promise.allSettled([apiPool.end(), worker.end(), owner.end()]);
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await dropDisconnectedDatabase(admin, databaseName);
    } finally {
      await admin.end();
    }
  };

  return Object.freeze({
    apiConfig,
    workerConfig,
    dispatcherConfig,
    actorId,
    workspaceId,
    ids,
    authoring,
    queue,
    initialize,
    ownerQuery,
    workerQuery,
    transition: (
      command: 'archive' | 'restore',
      expectedLifecycleRevision: number,
      idempotencyKey: string,
    ) =>
      authoring.transitionWorkflowLifecycle({
        actorId,
        command,
        expectedLifecycleRevision,
        idempotencyKey,
        workflowId: ids.workflow,
        workspaceId,
      }),
    readProjection,
    readRunSnapshot,
    readOutboxEvent,
    makeDue: async (id: string) => {
      await ownerQuery(
        `update app.outbox_events set available_at=clock_timestamp() where id=$1`,
        [id],
      );
    },
    createRuntime,
    createDispatcher,
    readyCapabilities,
    close,
  });
}

export { JOB_NAME, jobIdForOutboxEvent };
export type { QueueConsumer };
