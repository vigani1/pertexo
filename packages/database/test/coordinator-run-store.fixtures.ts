import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { FailureNotificationContextV1Schema } from '@pertexo/workflow-model/failure-notification';

import {
  canonicalOutboxPayloadChecksum,
  CoordinatorPlanInvalidError,
  CoordinatorRunStateCorruptError,
  checkDatabaseReadiness,
  createCoordinatorRunStore,
  createFailureNotificationStore,
  createDeadlineWakeupScanner,
  createDueNodeWakeupScanner,
  createNodeAttemptRunStore,
  NodeAttemptDeliveryMismatchError,
  NodeAttemptConnectionFenceError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptStateCorruptError,
  parseDatabaseConfig,
} from '../src/index.js';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';

const adminBaseUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const databaseName = `pertexo_test_0016_run_store_${randomUUID().replaceAll('-', '')}`;
const zeroDatabaseName = `pertexo_test_0016_zero_${randomUUID().replaceAll('-', '')}`;
const priorHeadDatabaseName = `pertexo_test_0030_upgrade_${randomUUID().replaceAll('-', '')}`;

const actorId = randomUUID();
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const workflowA = randomUUID();
const workflowB = randomUUID();
const versionA = randomUUID();
const versionB = randomUUID();
const retainedRunId = randomUUID();
const retainedLegacyNodeRunId = randomUUID();
const retainedLegacyInvocationKey = 'legacy/node#1';
const notificationConnectionId = randomUUID();
const notificationSecretVersionId = randomUUID();
const notificationDestinationId = randomUUID();

function namedDatabaseUrl(base: string, name: string): string {
  const value = new URL(base);
  value.pathname = `/${name}`;
  return value.toString();
}

function databaseUrl(base: string): string {
  return namedDatabaseUrl(base, databaseName);
}

const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: databaseUrl(migrationBaseUrl),
  dispatcherRole: 'pertexo_dispatcher',
  maintenanceRole: 'pertexo_maintenance',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

const rawStore = createCoordinatorRunStore(
  parseDatabaseConfig({
    connectionString: databaseUrl(workerBaseUrl),
    max: 6,
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  }),
);
const nodeAttemptStore = createNodeAttemptRunStore(
  parseDatabaseConfig({
    connectionString: databaseUrl(workerBaseUrl),
    max: 6,
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  }),
);

function checkpoint(input: {
  workflowVersionId?: string;
  revision?: number;
  runStatus?:
    | 'queued'
    | 'running'
    | 'waiting'
    | 'succeeded'
    | 'failed'
    | 'canceled'
    | 'timed_out'
    | 'outcome_unknown';
  nextEventSequence?: number;
  cancelRequested?: boolean;
  deadlineExpired?: boolean;
  invocations?: readonly Record<string, unknown>[];
  readySet?: readonly string[];
  admittedInvocationKeys?: readonly string[];
}) {
  return {
    schemaVersion: 1,
    engineVersion: 'engine-v1',
    workflowVersionId: input.workflowVersionId ?? versionA,
    revision: input.revision ?? 0,
    runStatus: input.runStatus ?? 'queued',
    nextEventSequence: input.nextEventSequence ?? 2,
    readySet: input.readySet ?? [],
    admittedInvocationKeys: input.admittedInvocationKeys ?? [],
    invocations: input.invocations ?? [],
    joins: [],
    loops: [],
    remainingIterationBudget: 0,
    cancelRequested: input.cancelRequested ?? false,
    deadlineExpired: input.deadlineExpired ?? false,
  } as const;
}

async function createDatabase(): Promise<void> {
  const admin = new Pool({ connectionString: adminBaseUrl, max: 1 });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
    );
  } finally {
    await admin.end();
  }
}

async function dropDatabase(): Promise<void> {
  await Promise.all([store.close(), nodeAttemptStore.close()]);
  const admin = new Pool({ connectionString: adminBaseUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
}

async function migrateThrough0014(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-0014-'));
  try {
    const names = (await readdir(MIGRATIONS_DIRECTORY)).filter(
      (name) => /^\d{4}_.+\.sql$/u.test(name) && name < '0015_',
    );
    await Promise.all(
      names.map((name) =>
        copyFile(
          path.join(MIGRATIONS_DIRECTORY, name),
          path.join(directory, name),
        ),
      ),
    );
    await migrateDatabase(migrationConfig, directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function migrateThrough0015(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-0015-'));
  try {
    const names = (await readdir(MIGRATIONS_DIRECTORY)).filter(
      (name) => /^\d{4}_.+\.sql$/u.test(name) && name < '0016_',
    );
    await Promise.all(
      names.map((name) =>
        copyFile(
          path.join(MIGRATIONS_DIRECTORY, name),
          path.join(directory, name),
        ),
      ),
    );
    await migrateDatabase(migrationConfig, directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function migrateThrough0030(
  config: typeof migrationConfig,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-0030-'));
  try {
    const names = (await readdir(MIGRATIONS_DIRECTORY)).filter(
      (name) => /^\d{4}_.+\.sql$/u.test(name) && name < '0031_',
    );
    await Promise.all(
      names.map((name) =>
        copyFile(
          path.join(MIGRATIONS_DIRECTORY, name),
          path.join(directory, name),
        ),
      ),
    );
    await migrateDatabase(config, directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function asOwner<T>(
  workspaceId: string,
  operation: (client: Pool) => Promise<T>,
): Promise<T> {
  const client = new Pool({
    connectionString: databaseUrl(migrationBaseUrl),
    max: 1,
  });
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function asAdmin<T>(operation: (client: Pool) => Promise<T>): Promise<T> {
  const client = new Pool({
    connectionString: databaseUrl(adminBaseUrl),
    max: 1,
  });
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function asRuntime<T>(
  baseUrl: string,
  workspaceId: string,
  operation: (client: Pool) => Promise<T>,
): Promise<T> {
  const client = new Pool({ connectionString: databaseUrl(baseUrl), max: 1 });
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

type CommitInput = Parameters<typeof rawStore.commitAdvancePlan>[0];
type TestAcknowledgeInput = Parameters<
  typeof rawStore.acknowledgeAdvanceDelivery
>[0];
type TestLoadInput = Parameters<typeof rawStore.loadAdvanceState>[0];
type TestCommitInput = Omit<CommitInput, 'delivery'> &
  Readonly<{ delivery?: CommitInput['delivery'] }>;
const testDeliveries = new Map<string, Promise<CommitInput['delivery']>>();

function testDelivery(
  workspaceId: string,
  runId: string,
  expectedRevision: unknown,
): Promise<CommitInput['delivery']> {
  const key = `${workspaceId}:${runId}:${String(expectedRevision)}`;
  const existing = testDeliveries.get(key);
  if (existing !== undefined) return existing;
  const created = (async (): Promise<CommitInput['delivery']> => {
    const outboxEventId = randomUUID();
    const payload = { schemaVersion: 1, workspaceId, outboxEventId, runId };
    const payloadChecksum = canonicalOutboxPayloadChecksum(payload);
    await asRuntime(workerBaseUrl, workspaceId, (client) =>
      client.query(
        `insert into app.outbox_events (
           id,workspace_id,job_name,schema_version,aggregate_type,
           aggregate_id,payload,payload_checksum
         ) values ($1,$2,'advance-workflow-run',1,'workflow-run',$3,$4::jsonb,$5)`,
        [
          outboxEventId,
          workspaceId,
          runId,
          JSON.stringify(payload),
          payloadChecksum,
        ],
      ),
    );
    return Object.freeze({ outboxEventId, payloadChecksum });
  })();
  testDeliveries.set(key, created);
  return created;
}

const store = Object.freeze({
  acknowledgeAdvanceDelivery: (input: TestAcknowledgeInput) =>
    rawStore.acknowledgeAdvanceDelivery(input),
  close: () => rawStore.close(),
  loadAdvanceState: (input: TestLoadInput) => rawStore.loadAdvanceState(input),
  commitAdvancePlan: async (input: TestCommitInput) =>
    rawStore.commitAdvancePlan({
      ...input,
      delivery:
        input.delivery ??
        (await testDelivery(
          input.workspaceId,
          input.runId,
          typeof input.plan === 'object' &&
            input.plan !== null &&
            'expectedRevision' in input.plan
            ? input.plan.expectedRevision
            : undefined,
        )),
    }),
});

async function seedIdentityAndExecutables(): Promise<void> {
  await asOwner(workspaceA, async (client) => {
    await client.query('alter table app.workflows no force row level security');
    await client.query(
      'alter table app.workflow_versions no force row level security',
    );
    for (const table of [
      'connections',
      'connection_secret_versions',
      'failure_notification_destinations',
      'failure_notification_destination_versions',
    ])
      await client.query(
        `alter table app.${table} no force row level security`,
      );
    await client.query(
      `insert into app.users (id,email,display_name) values ($1,$2,'Run Store')`,
      [actorId, `run-store-${actorId}@example.test`],
    );
    for (const [workspaceId, workflowId, versionId, suffix] of [
      [workspaceA, workflowA, versionA, 'a'],
      [workspaceB, workflowB, versionB, 'b'],
    ] as const) {
      await client.query(
        `insert into app.workspaces (id,name,slug,created_by)
         values ($1,$2,$3,$4)`,
        [
          workspaceId,
          `Workspace ${suffix}`,
          `run-store-${suffix}-${workspaceId.slice(0, 8)}`,
          actorId,
        ],
      );
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.workspace_execution_entitlement_versions (
           workspace_id,version,status,active_run_limit,queued_run_limit,effective_at
         ) values ($1,2,'active',10000,100000,'-infinity'::timestamptz)`,
        [workspaceId],
      );
      await client.query(
        `update app.workspace_execution_entitlements set current_version=2
          where workspace_id=$1`,
        [workspaceId],
      );
      await client.query(
        `insert into app.workflows (id,workspace_id,name,created_by)
         values ($1,$2,$3,$4)`,
        [workflowId, workspaceId, `Workflow ${suffix}`, actorId],
      );
      await client.query(
        `insert into app.workflow_versions (
           id,workspace_id,workflow_id,version_number,schema_version,graph_json,
           checksum,executable_schema_version,executable_json,
           compatibility_release_epoch,published_by
         ) values ($1,$2,$3,1,1,'{}'::jsonb,$4,2,$5::jsonb,1,$6)`,
        [
          versionId,
          workspaceId,
          workflowId,
          `wf:v2:sha256:${suffix.repeat(64)}`,
          JSON.stringify({ schemaVersion: 2, nodes: [], edges: [] }),
          actorId,
        ],
      );
    }
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceA,
    ]);
    await client.query(
      `insert into app.connections (
         id,workspace_id,provider_key,name,auth_type,status,
         current_secret_version_id,created_by
       ) values ($1,$2,'email','Run failure email','resend_api_key','active',$3,$4)`,
      [
        notificationConnectionId,
        workspaceA,
        notificationSecretVersionId,
        actorId,
      ],
    );
    await client.query(
      `insert into app.connection_secret_versions (
         id,workspace_id,connection_id,schema_version,kms_key_reference,
         encrypted_data_key,ciphertext,nonce,auth_tag,created_by
       ) values ($1,$2,$3,1,'kms','key','cipher','AAAAAAAAAAAAAAAA',
         'AAAAAAAAAAAAAAAAAAAAAA',$4)`,
      [
        notificationSecretVersionId,
        workspaceA,
        notificationConnectionId,
        actorId,
      ],
    );
    await client.query(
      `insert into app.failure_notification_destinations
         (id,workspace_id,kind,status,current_config_version,created_by)
       values ($1,$2,'email','enabled',1,$3)`,
      [notificationDestinationId, workspaceA, actorId],
    );
    await client.query(
      `insert into app.failure_notification_destination_versions
         (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
       values ($1,$2,1,'email','idempotent_with_key',$3::jsonb,$4)`,
      [
        workspaceA,
        notificationDestinationId,
        JSON.stringify({
          connectionId: notificationConnectionId,
          toEmail: 'run-store@example.test',
        }),
        actorId,
      ],
    );
    await client.query('alter table app.workflows force row level security');
    await client.query(
      'alter table app.workflow_versions force row level security',
    );
    await client.query('set constraints all immediate');
    for (const table of [
      'connections',
      'connection_secret_versions',
      'failure_notification_destinations',
      'failure_notification_destination_versions',
    ])
      await client.query(`alter table app.${table} force row level security`);
  });
}

async function insertRun(input: {
  workspaceId?: string;
  workflowId?: string;
  workflowVersionId?: string;
  schedulerState?: unknown;
  status?: string;
  triggerType?: string;
  deadlineAt?: string;
  inputRef?: unknown;
  failureNotificationPolicy?: Readonly<{
    destinationId: string;
    destinationConfigVersion: number;
    sideEffectClass: string;
    connectionSecretVersionId: string;
  }>;
}): Promise<string> {
  const workspaceId = input.workspaceId ?? workspaceA;
  const runId = randomUUID();
  const workflowVersionId = input.workflowVersionId ?? versionA;
  await asRuntime(apiBaseUrl, workspaceId, async (client) => {
    await client.query(
      `insert into app.workflow_runs (
         id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
           deadline_at,input_ref,input_ref_expires_at,
           failure_notification_policy_version,
          failure_notification_destination_id,
           failure_notification_destination_config_version,
           failure_notification_side_effect_class,
           failure_notification_connection_secret_version_id
          ) values ($1,$2,$3,$4,$13,$5,$6,$7::jsonb,
            case when $7::jsonb is null then null else now()+interval '30 days' end,
            $8,$9,$10,$11,$12)`,
      [
        runId,
        workspaceId,
        input.workflowId ?? workflowA,
        workflowVersionId,
        input.status ?? 'queued',
        input.deadlineAt ?? null,
        input.inputRef === undefined ? null : JSON.stringify(input.inputRef),
        input.failureNotificationPolicy === undefined ? null : 1,
        input.failureNotificationPolicy?.destinationId ?? null,
        input.failureNotificationPolicy?.destinationConfigVersion ?? null,
        input.failureNotificationPolicy?.sideEffectClass ?? null,
        input.failureNotificationPolicy?.connectionSecretVersionId ?? null,
        input.triggerType ?? 'manual',
      ],
    );
    await client.query(
      `insert into app.run_events
         (workspace_id,workflow_run_id,sequence,type,payload)
       values ($1,$2,1,'run.queued','{"schemaVersion":1}'::jsonb)`,
      [workspaceId, runId],
    );
    const state = input.schedulerState ?? checkpoint({ workflowVersionId });
    const stateRevision =
      typeof input.schedulerState === 'object' &&
      input.schedulerState !== null &&
      'revision' in input.schedulerState &&
      typeof input.schedulerState.revision === 'number'
        ? input.schedulerState.revision
        : 0;
    await client.query(
      `insert into app.run_checkpoints (
         workflow_run_id,workspace_id,workflow_version_id,revision,
         engine_version,scheduler_state
       ) values ($1,$2,$3,$4,'engine-v1',$5::jsonb)`,
      [
        runId,
        workspaceId,
        workflowVersionId,
        stateRevision,
        JSON.stringify(state),
      ],
    );
  });
  return runId;
}

async function seedSucceededFact(
  runId: string,
  invocationKey: string,
  storedValue: unknown,
): Promise<Readonly<{ attemptId: string; nodeRunId: string }>> {
  const nodeRunId = randomUUID();
  const attemptId = randomUUID();
  await asRuntime(workerBaseUrl, workspaceA, async (client) => {
    await client.query(
      `insert into app.node_runs (
         id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
         status,side_effect_class,current_attempt_id,current_attempt_number,output_ref
       ) values ($1,$2,$3,$4,$5,'{}','succeeded','safe',$6,1,$7::jsonb)`,
      [
        nodeRunId,
        workspaceA,
        runId,
        invocationKey.split('/').at(-1) ?? invocationKey,
        invocationKey,
        attemptId,
        JSON.stringify(storedValue),
      ],
    );
    await client.query(
      `insert into app.node_attempts (
         id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
       ) values ($1,$2,$3,1,'succeeded','safe',$4::jsonb)`,
      [attemptId, workspaceA, nodeRunId, JSON.stringify(storedValue)],
    );
    await client.query(
      `insert into app.run_events
         (workspace_id,workflow_run_id,sequence,type,payload)
       values ($1,$2,2,'node.succeeded',$3::jsonb)`,
      [
        workspaceA,
        runId,
        JSON.stringify({ schemaVersion: 1, nodeRunId, attemptId }),
      ],
    );
  });
  return { nodeRunId, attemptId };
}

beforeAll(async () => {
  await createDatabase();
  await migrateThrough0014();
  await asRuntime(apiBaseUrl, workspaceA, async (client) => {
    await client.query(
      `insert into app.workflow_runs
         (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
       values ($1,$2,$3,$4,'manual','queued')`,
      [retainedRunId, workspaceA, randomUUID(), randomUUID()],
    );
    await client.query(
      `insert into app.run_checkpoints
         (workflow_run_id,workspace_id,revision,engine_version,scheduler_state)
       values ($1,$2,0,'phase0','{}'::jsonb)`,
      [retainedRunId, workspaceA],
    );
  });
  await migrateThrough0015();
  await asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query(
      `insert into app.node_runs (
         id,workspace_id,workflow_run_id,node_id,invocation_key,
         branch_context,status,side_effect_class
       ) values ($1,$2,$3,'legacy-node',$4,'{}'::jsonb,'pending','safe')`,
      [
        retainedLegacyNodeRunId,
        workspaceA,
        retainedRunId,
        retainedLegacyInvocationKey,
      ],
    ),
  );
  await migrateDatabase(migrationConfig);
  await seedIdentityAndExecutables();
}, 60_000);

afterAll(dropDatabase);

export {
  CoordinatorPlanInvalidError,
  CoordinatorRunStateCorruptError,
  FailureNotificationContextV1Schema,
  MIGRATIONS_DIRECTORY,
  NodeAttemptConnectionFenceError,
  NodeAttemptDeliveryMismatchError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptStateCorruptError,
  Pool,
  actorId,
  adminBaseUrl,
  apiBaseUrl,
  asAdmin,
  asOwner,
  asRuntime,
  canonicalOutboxPayloadChecksum,
  checkDatabaseReadiness,
  checkpoint,
  copyFile,
  createCoordinatorRunStore,
  createDatabase,
  createDeadlineWakeupScanner,
  createDueNodeWakeupScanner,
  createFailureNotificationStore,
  createHash,
  createNodeAttemptRunStore,
  databaseName,
  databaseUrl,
  dropDatabase,
  dropDisconnectedDatabase,
  insertRun,
  migrateDatabase,
  migrateThrough0014,
  migrateThrough0015,
  migrateThrough0030,
  migrationBaseUrl,
  migrationConfig,
  mkdtemp,
  namedDatabaseUrl,
  nodeAttemptStore,
  notificationConnectionId,
  notificationDestinationId,
  notificationSecretVersionId,
  parseDatabaseConfig,
  path,
  priorHeadDatabaseName,
  randomUUID,
  rawStore,
  readdir,
  retainedLegacyInvocationKey,
  retainedLegacyNodeRunId,
  retainedRunId,
  rm,
  seedIdentityAndExecutables,
  seedSucceededFact,
  store,
  testDeliveries,
  testDelivery,
  tmpdir,
  versionA,
  versionB,
  workerBaseUrl,
  workflowA,
  workflowB,
  workspaceA,
  workspaceB,
  zeroDatabaseName,
};
