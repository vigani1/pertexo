import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
          ) values ($1,$2,$3,$4,'manual',$5,$6,$7::jsonb,
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

describe('CoordinatorRunStore on disposable PostgreSQL', () => {
  it('defers queued coordination durably until an active entitlement slot is free', async () => {
    await asOwner(workspaceA, async (client) => {
      await client.query(
        `insert into app.workspace_execution_entitlement_versions (
           workspace_id,version,status,active_run_limit,queued_run_limit,effective_at
         ) values ($1,3,'active',5,100,'-infinity'::timestamptz)`,
        [workspaceA],
      );
      await client.query(
        `update app.workspace_execution_entitlements set current_version=3
          where workspace_id=$1`,
        [workspaceA],
      );
    });
    const activeRunIds = await Promise.all(
      Array.from({ length: 5 }, () => insertRun({ status: 'running' })),
    );
    const runId = await insertRun({});
    await asOwner(workspaceA, (client) =>
      client.query(
        `update app.workspace_execution_entitlements set current_version=2
          where workspace_id=$1`,
        [workspaceA],
      ),
    );
    const plan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 3,
      }),
      events: [
        {
          schemaVersion: 1 as const,
          sequence: 2,
          name: 'run.started' as const,
          occurredAt: '2026-08-25T00:00:00.000Z',
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    };
    const delivery = await testDelivery(workspaceA, runId, 0);
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        delivery,
        plan,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'deferred', revision: 0 });

    const deferred = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ id: string; payload_checksum: string }>(
        `select id,payload_checksum from app.outbox_events
          where workspace_id=$1 and aggregate_id=$2 and job_name='advance-workflow-run'
            and id<>$3
          order by created_at desc limit 1`,
        [workspaceA, runId, delivery.outboxEventId],
      ),
    );
    expect(deferred.rows).toHaveLength(1);
    const retry = deferred.rows[0];
    if (retry === undefined)
      throw new Error('Deferred coordinator row missing');
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `update app.workflow_runs set status='succeeded',completed_at=clock_timestamp()
          where workspace_id=$1 and id=$2`,
        [workspaceA, activeRunIds[0]],
      ),
    );
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        delivery: {
          outboxEventId: retry.id,
          payloadChecksum: retry.payload_checksum,
        },
        plan,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        active_runs: number;
        actual_queued: number;
        queued_runs: number;
        run_status: string;
      }>(
        `select counter.active_runs,counter.queued_runs,run.status run_status,
                (select count(*)::integer from app.workflow_runs queued
                  where queued.workspace_id=counter.workspace_id
                    and queued.status='queued') actual_queued
           from app.workspace_execution_admission_counters counter
           join app.workflow_runs run on run.workspace_id=counter.workspace_id
          where counter.workspace_id=$1 and run.id=$2`,
        [workspaceA, runId],
      ),
    );
    expect(proof.rows).toEqual([
      {
        active_runs: 5,
        actual_queued: 1,
        queued_runs: 1,
        run_status: 'running',
      },
    ]);
  });

  it('atomically creates one safe failure notification intent and excludes cancellation', async () => {
    const invocationKey = 'failure/primary';
    const runId = await insertRun({
      status: 'running',
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'primary',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      failureNotificationPolicy: {
        destinationId: notificationDestinationId,
        destinationConfigVersion: 1,
        sideEffectClass: 'idempotent_with_key',
        connectionSecretVersionId: notificationSecretVersionId,
      },
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,current_attempt_id,current_attempt_number
         ) values ($1,$2,$3,'primary',$4,'{}','running','safe',$5,1)`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId],
      );
      await client.query(
        `insert into app.node_attempts (
           id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
           safe_error_code,executor_failure_kind,executor_error_kind,
           executor_possibly_dispatched,retry_decision
         ) values ($1,$2,$3,1,'failed','safe','provider.unavailable',
           'failed','provider',false,'pending')`,
        [attemptId, workspaceA, nodeRunId],
      );
    });
    const plan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'failed',
        nextEventSequence: 4,
        invocations: [
          {
            invocationKey,
            nodeId: 'primary',
            status: 'failed',
            attemptNumber: 1,
          },
        ],
      }),
      events: [
        {
          schemaVersion: 1 as const,
          sequence: 2,
          name: 'node.failed' as const,
          occurredAt: '2026-08-24T10:01:00.000Z',
          invocationKey,
          nodeId: 'primary',
          attemptNumber: 1,
          reasonCode: 'provider.unavailable',
        },
        {
          schemaVersion: 1 as const,
          sequence: 3,
          name: 'run.failed' as const,
          occurredAt: '2026-08-24T10:01:00.000Z',
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    };
    const input = {
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan,
    };
    await expect(store.commitAdvancePlan(input)).resolves.toMatchObject({
      kind: 'committed',
    });
    await expect(store.commitAdvancePlan(input)).resolves.toMatchObject({
      kind: 'already_committed',
    });
    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        intent_count: number;
        outbox_count: number;
        context: Record<string, unknown>;
      }>(
        `select count(distinct intent.id)::int intent_count,
                count(distinct outbox.id)::int outbox_count,
                min(intent.context::text)::jsonb context
         from app.run_failure_notification_intents intent
         join app.outbox_events outbox on outbox.aggregate_id=intent.id
         where intent.workspace_id=$1 and intent.workflow_run_id=$2`,
        [workspaceA, runId],
      ),
    );
    expect(proof.rows[0]).toMatchObject({ intent_count: 1, outbox_count: 1 });
    const persistedContext = FailureNotificationContextV1Schema.parse(
      proof.rows[0]?.context,
    );
    expect(persistedContext.terminalStatus).toBe('failed');
    expect(persistedContext.primaryFailure).toMatchObject({
      invocationKey,
      safeErrorCode: 'provider.unavailable',
    });
    expect(JSON.stringify(proof.rows[0]?.context)).not.toMatch(
      /errorSummary|secret|input|output|connection|actor/i,
    );
    const hidden = await asRuntime(workerBaseUrl, workspaceB, (client) =>
      client.query(
        `select id from app.run_failure_notification_intents where workflow_run_id=$1`,
        [runId],
      ),
    );
    expect(hidden.rowCount).toBe(0);

    const deliveryStore = createFailureNotificationStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 4,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    );
    try {
      const identity = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          intent_id: string;
          outbox_id: string;
          payload_checksum: string;
        }>(
          `select intent.id intent_id,outbox.id outbox_id,outbox.payload_checksum
           from app.run_failure_notification_intents intent
           join app.outbox_events outbox on outbox.aggregate_id=intent.id
           where intent.workflow_run_id=$1 order by outbox.created_at limit 1`,
          [runId],
        ),
      );
      const first = identity.rows[0];
      if (first === undefined) throw new Error('notification fixture missing');
      const claimInput = {
        workspaceId: workspaceA,
        intentId: first.intent_id,
        delivery: {
          outboxEventId: first.outbox_id,
          payloadChecksum: first.payload_checksum,
        },
        recoverySeconds: 1,
        maxAttempts: 3,
      } as const;
      await asRuntime(apiBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='disabled'
            where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      const claims = await Promise.all([
        deliveryStore.claimDelivery(claimInput),
        deliveryStore.claimDelivery(claimInput),
      ]);
      expect(claims.map(({ kind }) => kind).sort()).toEqual(['busy', 'ready']);
      const ready = claims.find(({ kind }) => kind === 'ready');
      expect(ready?.kind).toBe('ready');
      if (ready?.kind !== 'ready') throw new Error('delivery claim missing');
      expect(ready.context.runId).toBe(runId);

      await asRuntime(apiBaseUrl, workspaceA, async (client) => {
        await client.query(
          `insert into app.failure_notification_destination_versions
             (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
           select workspace_id,destination_id,2,kind,side_effect_class,
                  jsonb_set(config,'{toEmail}','"changed@example.test"'),$3
             from app.failure_notification_destination_versions
            where workspace_id=$1 and destination_id=$2 and version=1`,
          [workspaceA, notificationDestinationId, actorId],
        );
        await client.query(
          `update app.failure_notification_destinations
              set current_config_version=2,status='disabled'
             where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        );
      });
      await expect(
        deliveryStore.loadDestination({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          workerId: 'notification-test-worker',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('Delivery destination is unavailable');
      await asRuntime(apiBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='enabled'
            where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      await expect(
        deliveryStore.loadDestination({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          workerId: 'notification-test-worker',
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        kind: 'email',
        secretVersionId: notificationSecretVersionId,
        toEmail: 'run-store@example.test',
      });

      const disablePool = new Pool({
        connectionString: databaseUrl(apiBaseUrl),
        max: 1,
      });
      const disableClient = await disablePool.connect();
      try {
        await disableClient.query('begin');
        await disableClient.query(
          "select set_config('app.workspace_id',$1,true)",
          [workspaceA],
        );
        await disableClient.query(
          `update app.failure_notification_destinations set status='disabled'
            where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        );
        let fenceSettled = false;
        const disabledFence = deliveryStore
          .fenceDispatch({
            workspaceId: workspaceA,
            intentId: first.intent_id,
            attemptNumber: ready.attemptNumber,
            deliveryBinding: `email:v1:sha256:${'a'.repeat(64)}`,
          })
          .then(
            () => ({ kind: 'resolved' as const }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
          )
          .finally(() => {
            fenceSettled = true;
          });
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(fenceSettled).toBe(false);
        await disableClient.query('commit');
        const fenceResult = await disabledFence;
        expect(fenceSettled).toBe(true);
        expect(fenceResult.kind).toBe('rejected');
        if (fenceResult.kind !== 'rejected')
          throw new Error('disabled destination fence unexpectedly committed');
        expect(fenceResult.error).toEqual(
          expect.objectContaining({
            message: 'Delivery dispatch fence failed',
          }),
        );
      } finally {
        await disableClient.query('rollback').catch(() => undefined);
        disableClient.release();
        await disablePool.end();
      }
      await asRuntime(apiBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='enabled'
            where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      await expect(
        deliveryStore.fenceDispatch({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          deliveryBinding: `email:v1:sha256:${'a'.repeat(64)}`,
        }),
      ).resolves.toBeUndefined();
      await asRuntime(apiBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='disabled'
            where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{ status: string }>(
            `select status from app.run_failure_notification_intents
              where workspace_id=$1 and id=$2`,
            [workspaceA, first.intent_id],
          ),
        ),
      ).resolves.toMatchObject({ rows: [{ status: 'dispatching' }] });
      await asRuntime(apiBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='enabled'
            where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );

      await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.run_failure_notification_intents
           set recovery_at=clock_timestamp()-interval '1 second'
           where id=$1`,
          [first.intent_id],
        ),
      );
      await expect(deliveryStore.recoverDue(10, 3)).resolves.toBe(1);
      for (let attempt = 2; attempt <= 3; attempt += 1) {
        const next = await asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{ id: string; payload_checksum: string }>(
            `select id,payload_checksum from app.outbox_events
             where aggregate_id=$1 order by created_at desc,id desc limit 1`,
            [first.intent_id],
          ),
        );
        const outbox = next.rows[0];
        if (outbox === undefined) throw new Error('retry outbox missing');
        const claimed = await deliveryStore.claimDelivery({
          ...claimInput,
          delivery: {
            outboxEventId: outbox.id,
            payloadChecksum: outbox.payload_checksum,
          },
        });
        if (claimed.kind !== 'ready')
          throw new Error('retry was not claimable');
        if (attempt === 2) {
          const rotatedSecretVersionId = randomUUID();
          await asRuntime(apiBaseUrl, workspaceA, async (client) => {
            await client.query(
              `insert into app.connection_secret_versions (
                 id,workspace_id,connection_id,schema_version,kms_key_reference,
                 encrypted_data_key,ciphertext,nonce,auth_tag,created_by
               ) values ($1,$2,$3,1,'kms','key2','cipher2','BBBBBBBBBBBBBBBB',
                 'BBBBBBBBBBBBBBBBBBBBBB',$4)`,
              [
                rotatedSecretVersionId,
                workspaceA,
                notificationConnectionId,
                actorId,
              ],
            );
            await client.query(
              `update app.connections set current_secret_version_id=$3
                where workspace_id=$1 and id=$2`,
              [workspaceA, notificationConnectionId, rotatedSecretVersionId],
            );
          });
          await expect(
            deliveryStore.loadDestination({
              workspaceId: workspaceA,
              intentId: first.intent_id,
              attemptNumber: claimed.attemptNumber,
              workerId: 'notification-test-worker',
              signal: new AbortController().signal,
            }),
          ).rejects.toThrow('Delivery destination is unavailable');
        }
        const workerClock =
          attempt === 2
            ? vi
                .spyOn(Date, 'now')
                .mockReturnValue(Date.parse('2099-01-01T00:00:00.000Z'))
            : undefined;
        try {
          await expect(
            deliveryStore.completeDelivery({
              workspaceId: workspaceA,
              intentId: first.intent_id,
              attemptNumber: claimed.attemptNumber,
              maxAttempts: 3,
              retryDelaySeconds: attempt === 2 ? 30 : 0,
              result: {
                schemaVersion: 1,
                kind: 'retry',
                safeErrorCode: 'provider.unavailable',
                possiblyDispatched: false,
              },
            }),
          ).resolves.toBe('completed');
          if (attempt === 2) {
            const scheduled = await asRuntime(
              workerBaseUrl,
              workspaceA,
              (client) =>
                client.query<{
                  due_in_seconds: number;
                  id: string;
                  payload_checksum: string;
                }>(
                  `select extract(epoch from intent.next_delivery_at-clock_timestamp())::float8 due_in_seconds,
                          outbox.id,outbox.payload_checksum
                   from app.run_failure_notification_intents intent
                   join app.outbox_events outbox on outbox.aggregate_id=intent.id
                   where intent.id=$1 order by outbox.created_at desc,outbox.id desc limit 1`,
                  [first.intent_id],
                ),
            );
            const retry = scheduled.rows[0];
            expect(retry?.due_in_seconds).toBeGreaterThan(25);
            expect(retry?.due_in_seconds).toBeLessThanOrEqual(30);
            if (retry === undefined) throw new Error('retry schedule missing');
            await expect(
              deliveryStore.claimDelivery({
                ...claimInput,
                delivery: {
                  outboxEventId: retry.id,
                  payloadChecksum: retry.payload_checksum,
                },
              }),
            ).resolves.toEqual({ kind: 'busy' });
            await asRuntime(workerBaseUrl, workspaceA, (client) =>
              client.query(
                `update app.run_failure_notification_intents
                 set next_delivery_at=clock_timestamp()-interval '1 second'
                 where id=$1`,
                [first.intent_id],
              ),
            );
          }
        } finally {
          workerClock?.mockRestore();
        }
      }
      const terminal = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          status: string;
          run_status: string;
          event_count: number;
        }>(
          `select intent.status,run.status run_status,
                  (select count(*)::int from app.run_events event
                    where event.workflow_run_id=run.id) event_count
           from app.run_failure_notification_intents intent
           join app.workflow_runs run on run.id=intent.workflow_run_id
           where intent.id=$1`,
          [first.intent_id],
        ),
      );
      expect(terminal.rows[0]).toEqual({
        status: 'outcome_unknown',
        run_status: 'failed',
        event_count: 3,
      });

      const exhaustedId = randomUUID();
      await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `insert into app.run_failure_notification_intents (
             id,workspace_id,workflow_run_id,terminal_event_sequence,policy_version,
             destination_id,destination_config_version,side_effect_class,
             connection_secret_version_id,delivery_binding,context,context_checksum,
             status,delivery_attempts,dispatch_marked_at,recovery_at,possibly_dispatched
           ) select $1,workspace_id,workflow_run_id,terminal_event_sequence+2,policy_version,
                    destination_id,destination_config_version,'idempotent_with_key',
                    connection_secret_version_id,$3,context,context_checksum,
                    'dispatching',3,clock_timestamp(),clock_timestamp()+interval '1 minute',true
               from app.run_failure_notification_intents where id=$2`,
          [exhaustedId, first.intent_id, `email:v1:sha256:${'b'.repeat(64)}`],
        ),
      );
      await expect(
        deliveryStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: exhaustedId,
          attemptNumber: 3,
          maxAttempts: 3,
          retryDelaySeconds: 0,
          result: {
            schemaVersion: 1,
            kind: 'retry',
            safeErrorCode: 'delivery.provider_ambiguous',
            possiblyDispatched: true,
          },
        }),
      ).resolves.toBe('completed');
      const exhausted = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ status: string; possibly_dispatched: boolean }>(
          `select status,possibly_dispatched
               from app.run_failure_notification_intents where id=$1`,
          [exhaustedId],
        ),
      );
      expect(exhausted.rows[0]).toEqual({
        status: 'outcome_unknown',
        possibly_dispatched: true,
      });

      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `insert into app.run_failure_notification_intents (
             id,workspace_id,workflow_run_id,terminal_event_sequence,policy_version,
             destination_id,destination_config_version,side_effect_class,
             context,context_checksum,status,delivery_attempts,dispatch_marked_at,recovery_at
           ) select $1,workspace_id,workflow_run_id,terminal_event_sequence+1,policy_version,
                     destination_id,destination_config_version,'unsafe',context,context_checksum,
                    'dispatching',1,clock_timestamp()-interval '2 seconds',
                    clock_timestamp()-interval '1 second'
             from app.run_failure_notification_intents where id=$2`,
            [randomUUID(), first.intent_id],
          ),
        ),
      ).rejects.toThrow(
        'new failure notification intent must exactly match its run pin',
      );
    } finally {
      await deliveryStore.close();
    }

    const canceledRun = await insertRun({
      status: 'canceled',
      schedulerState: checkpoint({ runStatus: 'canceled' }),
    });
    const excluded = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        'select id from app.run_failure_notification_intents where workflow_run_id=$1',
        [canceledRun],
      ),
    );
    expect(excluded.rowCount).toBe(0);
  });
  it('atomically persists and reloads a scoped For Each barrier and first body admission', async () => {
    const controlKey = `${versionA}|loop|b:|i:`;
    const bodyKey = `${versionA}|body|b:|i:loop%3A0`;
    const controlNodeRunId = randomUUID();
    const controlAttemptId = randomUUID();
    const current = {
      ...checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey: controlKey,
            nodeId: 'loop',
            status: 'running',
            attemptNumber: 1,
            branchPath: [],
            iterationPath: [],
          },
        ],
        admittedInvocationKeys: [controlKey],
      }),
      schemaVersion: 2,
      branchSelections: [],
      initialIterationBudget: 2,
      remainingIterationBudget: 2,
    } as const;
    const runId = await insertRun({
      schedulerState: current,
      status: 'running',
    });
    const storedOutput = {
      schemaVersion: 1,
      kind: 'inline',
      value: { items: ['first', 'second'], iterationCount: 2 },
    };
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,current_attempt_id,current_attempt_number,output_ref
         ) values ($1,$2,$3,'loop',$4,$5::jsonb,'succeeded','safe',$6,1,$7::jsonb)`,
        [
          controlNodeRunId,
          workspaceA,
          runId,
          controlKey,
          JSON.stringify({ branchPath: [], iterationPath: [] }),
          controlAttemptId,
          JSON.stringify(storedOutput),
        ],
      );
      await client.query(
        `insert into app.node_attempts (
           id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
         ) values ($1,$2,$3,1,'succeeded','safe',$4::jsonb)`,
        [
          controlAttemptId,
          workspaceA,
          controlNodeRunId,
          JSON.stringify(storedOutput),
        ],
      );
      await client.query(
        `insert into app.run_events (
           workspace_id,workflow_run_id,sequence,type,payload
         ) values ($1,$2,2,'node.succeeded',$3::jsonb)`,
        [
          workspaceA,
          runId,
          JSON.stringify({
            schemaVersion: 1,
            nodeRunId: controlNodeRunId,
            attemptId: controlAttemptId,
          }),
        ],
      );
    });

    const loaded = await store.loadAdvanceState({
      workspaceId: workspaceA,
      runId,
      signal: new AbortController().signal,
    });
    expect(loaded).toMatchObject({
      kind: 'ready',
      state: {
        completedOutputs: [
          {
            invocationKey: controlKey,
            value: { items: ['first', 'second'], iterationCount: 2 },
          },
        ],
      },
    });

    const next = {
      ...current,
      revision: 1,
      nextEventSequence: 4,
      remainingIterationBudget: 0,
      admittedInvocationKeys: [controlKey, bodyKey],
      invocations: [
        {
          invocationKey: controlKey,
          nodeId: 'loop',
          status: 'waiting',
          attemptNumber: 1,
          output: { kind: 'inline', attemptId: controlAttemptId },
          branchPath: [],
          iterationPath: [],
        },
        {
          invocationKey: bodyKey,
          nodeId: 'body',
          status: 'running',
          attemptNumber: 1,
          branchPath: [],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
        },
      ],
      loops: [
        {
          controlInvocationKey: controlKey,
          loopId: 'loop',
          branchPath: [],
          iterationPath: [],
          bodyRootNodeIds: ['body'],
          bodySinkNodeId: 'body',
          collection: { kind: 'inline', attemptId: controlAttemptId },
          collectionChecksum: 'c'.repeat(64),
          collectionSize: 2,
          maxConcurrency: 1,
          maxIterations: 2,
          nextOrdinal: 1,
          activeOrdinals: [0],
          terminalOrdinals: [],
        },
      ],
    } as const;
    const plan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 2,
      checkpoint: next,
      events: [
        {
          schemaVersion: 1,
          sequence: 3,
          name: 'node.ready',
          occurredAt: '2026-08-24T00:00:00.000Z',
          invocationKey: bodyKey,
          nodeId: 'body',
          attemptNumber: 0,
        },
      ],
      nodeRunAdmissions: [
        {
          invocationKey: bodyKey,
          nodeId: 'body',
          sideEffectClass: 'safe',
          branchPath: [],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
        },
      ],
      attempts: [
        {
          invocationKey: bodyKey,
          nodeId: 'body',
          attemptNumber: 1,
          sideEffectClass: 'safe',
          branchPath: [],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
        },
      ],
    } as const;
    const delivery = await testDelivery(workspaceA, runId, 0);
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        delivery,
        plan,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        delivery,
        plan,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'already_committed', revision: 1 });

    const scanner = createDueNodeWakeupScanner(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 1,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    );
    await expect(scanner.claimDueWakeups(100)).resolves.toBe(0);
    await scanner.close();

    const freshStore = createCoordinatorRunStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 1,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    );
    await expect(
      freshStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: 'ready',
      state: { checkpoint: { revision: 1, loops: [{ nextOrdinal: 1 }] } },
    });
    await freshStore.close();

    const persisted = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        branch_context: unknown;
        control_kind: string | null;
        invocation_key: string;
        status: string;
      }>(
        `select invocation_key,branch_context,status,control_kind
         from app.node_runs where workflow_run_id=$1 order by invocation_key`,
        [runId],
      ),
    );
    expect(persisted.rows).toEqual([
      {
        invocation_key: bodyKey,
        branch_context: {
          branchPath: [],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
        },
        status: 'ready',
        control_kind: null,
      },
      {
        invocation_key: controlKey,
        branch_context: { branchPath: [], iterationPath: [] },
        status: 'waiting',
        control_kind: 'for_each_barrier',
      },
    ]);
    await asOwner(workspaceA, (client) =>
      client.query(
        `update app.node_runs set branch_context='{}'::jsonb
         where workflow_run_id=$1 and invocation_key=$2`,
        [runId, bodyKey],
      ),
    );
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });

  it('loads only exact ordinal-scoped body inputs and fails closed on loop proof drift', async () => {
    const controlKey = `${versionA}|loop|b:|i:`;
    const first0Key = `${versionA}|body-first|b:|i:loop%3A0`;
    const first1Key = `${versionA}|body-first|b:|i:loop%3A1`;
    const sink1Key = `${versionA}|body-sink|b:|i:loop%3A1`;
    const declarationAttemptId = randomUUID();
    const declarationNodeRunId = randomUUID();
    const first0AttemptId = randomUUID();
    const first0NodeRunId = randomUUID();
    const first1AttemptId = randomUUID();
    const first1NodeRunId = randomUUID();
    const sinkAttemptId = randomUUID();
    const sinkNodeRunId = randomUUID();
    const items = ['ordinal-zero', 'ordinal-one'];
    const collectionChecksum = createHash('sha256')
      .update(JSON.stringify(items))
      .digest('hex');
    const declarationOutput = {
      schemaVersion: 1,
      kind: 'inline',
      value: { items, iterationCount: 2 },
    };
    const inline = (value: unknown) => ({
      schemaVersion: 1,
      kind: 'inline',
      value,
    });
    const schedulerState = {
      schemaVersion: 2,
      engineVersion: 'engine-v1',
      workflowVersionId: versionA,
      revision: 1,
      runStatus: 'running',
      nextEventSequence: 2,
      readySet: [],
      admittedInvocationKeys: [controlKey, first0Key, first1Key, sink1Key],
      invocations: [
        {
          invocationKey: controlKey,
          nodeId: 'loop',
          status: 'waiting',
          attemptNumber: 1,
          output: { kind: 'inline', attemptId: declarationAttemptId },
          branchPath: [],
          iterationPath: [],
        },
        {
          invocationKey: first0Key,
          nodeId: 'body-first',
          status: 'succeeded',
          attemptNumber: 1,
          output: { kind: 'inline', attemptId: first0AttemptId },
          branchPath: [],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
        },
        {
          invocationKey: first1Key,
          nodeId: 'body-first',
          status: 'succeeded',
          attemptNumber: 1,
          output: { kind: 'inline', attemptId: first1AttemptId },
          branchPath: [],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 1 }],
        },
        {
          invocationKey: sink1Key,
          nodeId: 'body-sink',
          status: 'running',
          attemptNumber: 1,
          branchPath: [],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 1 }],
        },
      ],
      joins: [],
      loops: [
        {
          controlInvocationKey: controlKey,
          loopId: 'loop',
          branchPath: [],
          iterationPath: [],
          bodyRootNodeIds: ['body-first'],
          bodySinkNodeId: 'body-sink',
          collection: { kind: 'inline', attemptId: declarationAttemptId },
          collectionChecksum,
          collectionSize: 2,
          maxConcurrency: 2,
          maxIterations: 2,
          nextOrdinal: 2,
          activeOrdinals: [0, 1],
          terminalOrdinals: [],
        },
      ],
      remainingIterationBudget: 0,
      initialIterationBudget: 2,
      branchSelections: [],
      cancelRequested: false,
      deadlineExpired: false,
    } as const;
    const runId = await insertRun({
      schedulerState,
      status: 'running',
    });
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      for (const row of [
        {
          nodeRunId: declarationNodeRunId,
          attemptId: declarationAttemptId,
          nodeId: 'loop',
          invocationKey: controlKey,
          branchContext: { branchPath: [], iterationPath: [] },
          nodeStatus: 'waiting',
          attemptStatus: 'succeeded',
          output: declarationOutput,
          controlKind: 'for_each_barrier',
        },
        {
          nodeRunId: first0NodeRunId,
          attemptId: first0AttemptId,
          nodeId: 'body-first',
          invocationKey: first0Key,
          branchContext: {
            branchPath: [],
            iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
          },
          nodeStatus: 'succeeded',
          attemptStatus: 'succeeded',
          output: inline({ value: 'ordinal-zero' }),
          controlKind: null,
        },
        {
          nodeRunId: first1NodeRunId,
          attemptId: first1AttemptId,
          nodeId: 'body-first',
          invocationKey: first1Key,
          branchContext: {
            branchPath: [],
            iterationPath: [{ loopNodeId: 'loop', ordinal: 1 }],
          },
          nodeStatus: 'succeeded',
          attemptStatus: 'succeeded',
          output: inline({ value: 'ordinal-one' }),
          controlKind: null,
        },
        {
          nodeRunId: sinkNodeRunId,
          attemptId: sinkAttemptId,
          nodeId: 'body-sink',
          invocationKey: sink1Key,
          branchContext: {
            branchPath: [],
            iterationPath: [{ loopNodeId: 'loop', ordinal: 1 }],
          },
          nodeStatus: 'running',
          attemptStatus: 'running',
          output: null,
          controlKind: null,
        },
      ]) {
        await client.query(
          `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,
             branch_context,status,control_kind,side_effect_class,
             current_attempt_id,current_attempt_number,output_ref
           ) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'safe',$9,1,$10::jsonb)`,
          [
            row.nodeRunId,
            workspaceA,
            runId,
            row.nodeId,
            row.invocationKey,
            JSON.stringify(row.branchContext),
            row.nodeStatus,
            row.controlKind,
            row.attemptId,
            row.output === null ? null : JSON.stringify(row.output),
          ],
        );
        await client.query(
          `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,
             side_effect_class,lease_owner,lease_expires_at,fence_token,output_ref
           ) values ($1,$2,$3,1,$4::varchar,'safe',$5,
                     case when $4::varchar='running' then clock_timestamp()+interval '1 hour' else null end,
                     case when $4::varchar='running' then 1 else 0 end,$6::jsonb)`,
          [
            row.attemptId,
            workspaceA,
            row.nodeRunId,
            row.attemptStatus,
            row.attemptStatus === 'running' ? 'attempt-worker-loop' : null,
            row.output === null ? null : JSON.stringify(row.output),
          ],
        );
      }
    });
    const lease = {
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      nodeRunId: sinkNodeRunId,
      attemptId: sinkAttemptId,
      attemptNumber: 1,
      admissionKind: 'execute' as const,
      invocationKey: sink1Key,
      nodeId: 'body-sink',
      iterationPath: [{ loopNodeId: 'loop', ordinal: 1 }],
      sideEffectClass: 'safe' as const,
      workerId: 'attempt-worker-loop',
      fenceToken: 1,
      leaseExpiresAt: new Date(Date.now() + 3_600_000),
      delivery: {
        outboxEventId: randomUUID(),
        payloadChecksum: 'a'.repeat(64),
      },
    };
    const load = (upstreamInvocationKey = first1Key) =>
      nodeAttemptStore.loadInputs({
        lease,
        upstreamNodeOutputs: [
          {
            nodeId: 'body-first',
            invocationKey: upstreamInvocationKey,
          },
        ],
        signal: new AbortController().signal,
      });

    await expect(load()).resolves.toMatchObject({
      completedNodeOutputs: [
        {
          nodeId: 'body-first',
          invocationKey: first1Key,
          value: { value: 'ordinal-one' },
        },
      ],
      structuredCollection: {
        loopNodeId: 'loop',
        ordinal: 1,
        collection: items,
        collectionSize: 2,
        declaredCollectionChecksum: collectionChecksum,
      },
    });
    await expect(load(first0Key)).rejects.toBeInstanceOf(
      NodeAttemptStateCorruptError,
    );

    const replaceCheckpoint = async (next: unknown): Promise<void> => {
      const updated = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ scheduler_state: unknown }>(
          `update app.run_checkpoints set scheduler_state=$2::jsonb
           where workflow_run_id=$1 returning scheduler_state`,
          [runId, JSON.stringify(next)],
        ),
      );
      expect(updated.rowCount).toBe(1);
      expect(updated.rows[0]?.scheduler_state).toEqual(next);
    };
    await replaceCheckpoint({
      ...schedulerState,
      loops: [
        { ...schedulerState.loops[0], collectionChecksum: 'f'.repeat(64) },
      ],
    });
    await expect(load()).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
    await replaceCheckpoint({
      ...schedulerState,
      loops: [
        {
          ...schedulerState.loops[0],
          activeOrdinals: [0],
          terminalOrdinals: [1],
        },
      ],
    });
    await expect(load()).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
    const wrongAttemptId = randomUUID();
    await replaceCheckpoint({
      ...schedulerState,
      invocations: schedulerState.invocations.map((invocation) =>
        invocation.invocationKey === controlKey
          ? {
              ...invocation,
              output: { kind: 'inline', attemptId: wrongAttemptId },
            }
          : invocation,
      ),
      loops: [
        {
          ...schedulerState.loops[0],
          collection: { kind: 'inline', attemptId: wrongAttemptId },
        },
      ],
    });
    await expect(load()).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
  });

  it('loads and atomically resolves pending executor failure evidence', async () => {
    const invocationKey = 'coordinator/retry/pending';
    const attemptId = randomUUID();
    const nodeRunId = randomUUID();
    const runId = await insertRun({
      status: 'running',
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'retry-node',
            status: 'running',
            attemptNumber: 1,
          },
        ],
        admittedInvocationKeys: [invocationKey],
      }),
    });
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,current_attempt_id,current_attempt_number
         ) values ($1,$2,$3,'retry-node',$4,'{}','running','safe',$5,1)`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId],
      );
      await client.query(
        `insert into app.node_attempts (
           id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
           safe_error_code,executor_failure_kind,executor_error_kind,
           executor_possibly_dispatched,retry_decision,completed_at
         ) values ($1,$2,$3,1,'failed','safe','execution.rate_limit','retry',
                   'rate_limit',false,'pending',$4)`,
        [attemptId, workspaceA, nodeRunId, '2026-08-20T10:00:30.000Z'],
      );
    });

    const loaded = await store.loadAdvanceState({
      workspaceId: workspaceA,
      runId,
      signal: new AbortController().signal,
    });
    expect(loaded).toMatchObject({
      kind: 'ready',
      state: {
        observations: [
          {
            kind: 'attempt_failure',
            attemptId,
            invocationKey,
            failureKind: 'retry',
            errorKind: 'rate_limit',
            possiblyDispatched: false,
          },
        ],
      },
    });

    const dueAt = '2026-08-20T10:00:30.897Z';
    const nextCheckpoint = checkpoint({
      revision: 1,
      runStatus: 'waiting',
      nextEventSequence: 4,
      invocations: [
        {
          invocationKey,
          nodeId: 'retry-node',
          status: 'waiting',
          attemptNumber: 1,
          resumeAt: dueAt,
          waitKind: 'retry_backoff',
        },
      ],
      admittedInvocationKeys: [invocationKey],
    });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: nextCheckpoint,
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'node.retry_scheduled',
              occurredAt: '2026-08-20T10:01:00.000Z',
              invocationKey,
              nodeId: 'retry-node',
              attemptNumber: 1,
              dueAt,
            },
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'run.waiting',
              occurredAt: '2026-08-20T10:01:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });

    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await expect(
        client.query(
          `select node.status,node.retry_due_at,attempt.retry_decision
         from app.node_runs node join app.node_attempts attempt
           on attempt.workspace_id=node.workspace_id and attempt.id=node.current_attempt_id
         where node.id=$1`,
          [nodeRunId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            status: 'waiting',
            retry_due_at: new Date(dueAt),
            retry_decision: 'retry',
          },
        ],
      });
    });
  });

  it('migrates a zero database through 0016 and reports readiness', async () => {
    const admin = new Pool({ connectionString: adminBaseUrl, max: 1 });
    try {
      await admin.query(
        `drop database if exists "${zeroDatabaseName}" with (force)`,
      );
      await admin.query(
        `create database "${zeroDatabaseName}" owner pertexo_owner`,
      );
      await admin.query(
        `revoke all on database "${zeroDatabaseName}" from public`,
      );
      await admin.query(
        `grant connect on database "${zeroDatabaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
      );
      await migrateDatabase({
        ...migrationConfig,
        connectionString: namedDatabaseUrl(migrationBaseUrl, zeroDatabaseName),
      });
      const readinessPool = new Pool({
        connectionString: namedDatabaseUrl(workerBaseUrl, zeroDatabaseName),
        max: 1,
      });
      try {
        await expect(
          checkDatabaseReadiness(readinessPool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).resolves.toMatchObject({
          migrationHead: '0056_workspace_purge_foundation.sql',
          role: 'pertexo_worker',
        });
      } finally {
        await readinessPool.end();
      }
    } finally {
      await dropDisconnectedDatabase(admin, zeroDatabaseName);
      await admin.end();
    }
  }, 60_000);

  it('upgrades the immediate 0030 head to 0031 with compatible readiness and wakeup authority', async () => {
    const admin = new Pool({ connectionString: adminBaseUrl, max: 1 });
    const priorConfig = {
      ...migrationConfig,
      connectionString: namedDatabaseUrl(
        migrationBaseUrl,
        priorHeadDatabaseName,
      ),
    };
    try {
      await admin.query(
        `drop database if exists "${priorHeadDatabaseName}" with (force)`,
      );
      await admin.query(
        `create database "${priorHeadDatabaseName}" owner pertexo_owner`,
      );
      await admin.query(
        `revoke all on database "${priorHeadDatabaseName}" from public`,
      );
      await admin.query(
        `grant connect on database "${priorHeadDatabaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
      );
      await migrateThrough0030(priorConfig);
      const migrationPool = new Pool({
        connectionString: namedDatabaseUrl(
          workerBaseUrl,
          priorHeadDatabaseName,
        ),
        max: 1,
      });
      try {
        await expect(
          migrationPool.query<{ name: string }>(
            `select name from pertexo_internal.schema_migrations
             order by name desc limit 1`,
          ),
        ).resolves.toMatchObject({
          rows: [{ name: '0030_coordinator_retry_decisions.sql' }],
        });
      } finally {
        await migrationPool.end();
      }

      await expect(migrateDatabase(priorConfig)).resolves.toEqual([
        '0031_due_node_wakeups.sql',
        '0032_for_each_barriers.sql',
        '0033_durable_wait.sql',
        '0034_run_failure_notifications.sql',
        '0035_slack_bot_token_connections.sql',
        '0036_resend_api_key_connections.sql',
        '0037_failure_notification_destinations.sql',
        '0038_execution_admission.sql',
        '0039_webhook_triggers.sql',
        '0040_schedule_triggers.sql',
        '0041_trigger_hardening.sql',
        '0042_worker_run_admission_lock.sql',
        '0043_workflow_run_input_retention.sql',
        '0044_retention_control_foundation.sql',
        '0045_control_ledger_command_lock.sql',
        '0046_workspace_deletion_control_projection.sql',
        '0047_workspace_lifecycle_command_intents.sql',
        '0048_workspace_lifecycle_command_hardening.sql',
        '0049_workspace_deletion_side_effects.sql',
        '0050_workspace_lifecycle_api_authority.sql',
        '0051_workflow_run_input_retention_dry_run.sql',
        '0052_workflow_run_input_retention_enforcement.sql',
        '0053_preview_retention_enforcement.sql',
        '0054_workflow_run_input_retention_scheduling.sql',
        '0055_standard_retention_classes.sql',
        '0056_workspace_purge_foundation.sql',
      ]);
      const workerPool = new Pool({
        connectionString: namedDatabaseUrl(
          workerBaseUrl,
          priorHeadDatabaseName,
        ),
        max: 1,
      });
      try {
        await expect(
          checkDatabaseReadiness(workerPool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).resolves.toMatchObject({
          migrationHead: '0056_workspace_purge_foundation.sql',
          role: 'pertexo_worker',
        });
        await expect(
          workerPool.query<{ claimed: number }>(
            'select app.claim_due_node_run_wakeups(10)::integer claimed',
          ),
        ).resolves.toMatchObject({ rows: [{ claimed: 0 }] });
        await expect(
          workerPool.query<{
            column_present: boolean;
            execute_granted: boolean;
            function_owner: string;
            function_security_definer: boolean;
            update_granted: boolean;
          }>(
            `select
               exists (
                 select 1 from pg_attribute
                 where attrelid='app.node_runs'::regclass
                   and attname='due_wakeup_at' and not attisdropped
               ) column_present,
               has_function_privilege(
                 'pertexo_worker',
                 'app.claim_due_node_run_wakeups(integer)',
                 'EXECUTE'
               ) execute_granted,
               has_column_privilege(
                 'pertexo_worker','app.node_runs','due_wakeup_at','UPDATE'
               ) update_granted,
               pg_get_userbyid(proowner) function_owner,
               prosecdef function_security_definer
             from pg_proc
             where oid='app.claim_due_node_run_wakeups(integer)'::regprocedure`,
          ),
        ).resolves.toMatchObject({
          rows: [
            {
              column_present: true,
              execute_granted: true,
              function_owner: 'pertexo_owner',
              function_security_definer: true,
              update_granted: true,
            },
          ],
        });
      } finally {
        await workerPool.end();
      }
    } finally {
      await dropDisconnectedDatabase(admin, priorHeadDatabaseName);
      await admin.end();
    }
  }, 60_000);

  it('upgrades 0014 identity binding, reports readiness, and fails closed for legacy checkpoints', async () => {
    const readinessPool = new Pool({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
    });
    try {
      await expect(
        checkDatabaseReadiness(readinessPool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toMatchObject({
        migrationHead: '0056_workspace_purge_foundation.sql',
        role: 'pertexo_worker',
      });
      const catalog = await readinessPool.query<{
        event_payload_constraint: boolean;
        fingerprint_column: boolean;
        fingerprint_constraint: boolean;
        fingerprint_update: boolean;
        required_updates: boolean;
      }>(
        `select
           exists (
             select 1 from pg_constraint
             where conrelid='app.run_events'::regclass
               and conname='run_events_payload_bounded'
               and pg_get_constraintdef(oid) =
                 'CHECK ((octet_length((payload)::text) <= 524288))'
           ) event_payload_constraint,
           exists (
             select 1 from pg_attribute
             where attrelid='app.run_checkpoints'::regclass
               and attname='last_transition_fingerprint'
               and atttypid='character varying'::regtype and atttypmod=68
               and not attnotnull and not attisdropped
           ) fingerprint_column,
           exists (
             select 1 from pg_constraint
             where conrelid='app.run_checkpoints'::regclass
               and conname='run_checkpoints_transition_fingerprint_valid'
               and pg_get_constraintdef(oid) =
                 'CHECK (((last_transition_fingerprint IS NULL) OR ((last_transition_fingerprint)::text ~ ''^[0-9a-f]{64}$''::text)))'
           ) fingerprint_constraint,
           has_column_privilege('pertexo_worker','app.run_checkpoints','last_transition_fingerprint','UPDATE') fingerprint_update,
           not exists (
             select 1 from (values
               ('workflow_runs','status'),('workflow_runs','started_at'),
               ('workflow_runs','completed_at'),('workflow_runs','updated_at'),
               ('run_checkpoints','revision'),('run_checkpoints','engine_version'),
               ('run_checkpoints','scheduler_state'),
               ('run_checkpoints','last_transition_fingerprint'),
               ('run_checkpoints','resume_at'),
               ('run_checkpoints','resume_lease_owner'),
               ('run_checkpoints','resume_lease_token'),
               ('run_checkpoints','resume_lease_expires_at'),
               ('run_checkpoints','updated_at'),('node_runs','status'),
               ('node_runs','current_attempt_id'),
               ('node_runs','current_attempt_number'),('node_runs','resume_at'),
               ('node_runs','retry_due_at'),('node_runs','completed_at'),
               ('node_runs','safe_error_code'),('node_runs','updated_at'),
               ('node_attempts','status')
             ) required(table_name,column_name)
             where not has_column_privilege(
               'pertexo_worker','app.'||table_name,column_name,'UPDATE'
             )
           ) required_updates`,
      );
      expect(catalog.rows[0]).toEqual({
        event_payload_constraint: true,
        fingerprint_column: true,
        fingerprint_constraint: true,
        fingerprint_update: true,
        required_updates: true,
      });
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `update app.run_checkpoints
             set last_transition_fingerprint=$1
             where workflow_run_id=$2`,
            ['A'.repeat(64), retainedRunId],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });

      await asOwner(workspaceA, (client) =>
        client.query(
          'revoke update (last_transition_fingerprint) on app.run_checkpoints from pertexo_worker',
        ),
      );
      try {
        await expect(
          checkDatabaseReadiness(readinessPool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).rejects.toThrow('Coordinator RunStore grants are incompatible');
      } finally {
        await asOwner(workspaceA, (client) =>
          client.query(
            'grant update (last_transition_fingerprint) on app.run_checkpoints to pertexo_worker',
          ),
        );
      }
      await asOwner(workspaceA, (client) =>
        client.query('grant update on app.outbox_events to pertexo_worker'),
      );
      try {
        await expect(
          checkDatabaseReadiness(readinessPool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).rejects.toThrow('Coordinator RunStore grants are incompatible');
      } finally {
        await asOwner(workspaceA, (client) =>
          client.query(
            'revoke update on app.outbox_events from pertexo_worker',
          ),
        );
      }
      for (const [revoke, restore] of [
        [
          'revoke select on app.outbox_events from pertexo_worker',
          'grant select on app.outbox_events to pertexo_worker',
        ],
        [
          'revoke insert on app.transport_security_audit_facts from pertexo_worker',
          'grant insert on app.transport_security_audit_facts to pertexo_worker',
        ],
      ] as const) {
        await asOwner(workspaceA, (client) => client.query(revoke));
        try {
          await expect(
            checkDatabaseReadiness(readinessPool, {
              ownerRole: 'pertexo_owner',
              workerRuntimeRole: 'pertexo_worker',
            }),
          ).rejects.toThrow('Coordinator RunStore grants are incompatible');
        } finally {
          await asOwner(workspaceA, (client) => client.query(restore));
        }
      }
      await asOwner(workspaceA, (client) =>
        client.query(
          `alter policy inbox_receipts_workspace_scope on app.inbox_receipts
           using (true) with check (true)`,
        ),
      );
      try {
        await expect(
          checkDatabaseReadiness(readinessPool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).rejects.toThrow('Coordinator RunStore grants are incompatible');
      } finally {
        await asOwner(workspaceA, (client) =>
          client.query(
            `alter policy inbox_receipts_workspace_scope on app.inbox_receipts
             using (
               workspace_id::text = nullif(
                 current_setting('app.workspace_id', true), ''
               )
             )
             with check (
               workspace_id::text = nullif(
                 current_setting('app.workspace_id', true), ''
               )
             )`,
          ),
        );
      }

      await asOwner(workspaceA, (client) =>
        client.query(
          'alter table app.run_checkpoints drop constraint run_checkpoints_transition_fingerprint_valid',
        ),
      );
      try {
        await expect(
          checkDatabaseReadiness(readinessPool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).rejects.toThrow('Execution value persistence is incompatible');
      } finally {
        await asOwner(workspaceA, (client) =>
          client.query(
            `alter table app.run_checkpoints
             add constraint run_checkpoints_transition_fingerprint_valid
             check (
               last_transition_fingerprint is null
               or last_transition_fingerprint ~ '^[0-9a-f]{64}$'
             )`,
          ),
        );
      }
      await asOwner(workspaceA, (client) =>
        client.query(
          'alter table app.run_events drop constraint run_events_payload_bounded',
        ),
      );
      try {
        await expect(
          checkDatabaseReadiness(readinessPool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).rejects.toThrow('Execution value persistence is incompatible');
      } finally {
        await asOwner(workspaceA, (client) =>
          client.query(
            `alter table app.run_events
             add constraint run_events_payload_bounded
             check (octet_length(payload::text) <= 524288)`,
          ),
        );
      }
      await asOwner(workspaceA, (client) =>
        client.query(
          `alter policy artifacts_workspace_scope on app.artifacts
           using (true)`,
        ),
      );
      try {
        await expect(
          checkDatabaseReadiness(readinessPool, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).rejects.toThrow('Execution value persistence is incompatible');
      } finally {
        await asOwner(workspaceA, (client) =>
          client.query(
            `alter policy artifacts_workspace_scope on app.artifacts
             using (
               workspace_id::text = nullif(
                 current_setting('app.workspace_id', true), ''
               )
             )`,
          ),
        );
      }
      await expect(
        checkDatabaseReadiness(readinessPool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toMatchObject({
        migrationHead: '0056_workspace_purge_foundation.sql',
      });
    } finally {
      await readinessPool.end();
    }
    const binding = await asRuntime(apiBaseUrl, workspaceA, (client) =>
      client.query<{ matches: boolean }>(
        `select checkpoint.workflow_version_id = run.workflow_version_id as matches
         from app.run_checkpoints checkpoint
         join app.workflow_runs run on run.id=checkpoint.workflow_run_id
         where checkpoint.workflow_run_id=$1`,
        [retainedRunId],
      ),
    );
    expect(binding.rows[0]?.matches).toBe(true);
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId: retainedRunId,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'not_executable' });

    const legacyExecutable = await insertRun({ schedulerState: {} });
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId: legacyExecutable,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'unsupported_checkpoint' });
  });

  it('rejects provider keys outside idempotent-with-key node and attempt rows', async () => {
    const runId = await insertRun({});
    const nodeRunId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,
           branch_context,status,side_effect_class
         ) values ($1,$2,$3,'constraint-node',$4,'{}'::jsonb,'ready','safe')`,
        [nodeRunId, workspaceA, runId, `${versionA}|constraint-node|b:|i:`],
      ),
    );
    for (const [sideEffectClass, providerKey, suffix] of [
      ['safe', 'invalid', 'safe'],
      ['idempotent_with_key', null, 'idempotent'],
    ] as const)
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `insert into app.node_runs (
               id,workspace_id,workflow_run_id,node_id,invocation_key,
               branch_context,status,side_effect_class,provider_idempotency_key
             ) values ($1,$2,$3,$4,$5,'{}'::jsonb,'ready',$6,$7)`,
            [
              randomUUID(),
              workspaceA,
              runId,
              `invalid-${suffix}`,
              `${versionA}|invalid-${suffix}|b:|i:`,
              sideEffectClass,
              providerKey,
            ],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    for (const [sideEffectClass, providerKey] of [
      ['safe', 'invalid'],
      ['idempotent_with_key', null],
    ] as const) {
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `insert into app.node_attempts (
               id,workspace_id,node_run_id,attempt_number,status,
               side_effect_class,provider_idempotency_key
             ) values ($1,$2,$3,1,'ready',$4,$5)`,
            [randomUUID(), workspaceA, nodeRunId, sideEffectClass, providerKey],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('preserves legacy invocation keys and admits only canonical engine identities', async () => {
    const retained = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ invocation_key: string }>(
        `select invocation_key from app.node_runs
           where workspace_id=$1 and id=$2`,
        [workspaceA, retainedLegacyNodeRunId],
      ),
    );
    expect(retained.rows).toEqual([
      { invocation_key: retainedLegacyInvocationKey },
    ]);

    const runId = await insertRun({});
    const canonicalKey = `${versionA}|manual|b:|i:`;
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,
             branch_context,status,side_effect_class
           ) values ($1,$2,$3,'manual',$4,'{}'::jsonb,'pending','safe')`,
          [randomUUID(), workspaceA, runId, canonicalKey],
        ),
      ),
    ).resolves.toBeDefined();
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,
             branch_context,status,side_effect_class
           ) values ($1,$2,$3,'mapped',$4,'{}'::jsonb,'pending','safe')`,
          [
            randomUUID(),
            workspaceA,
            runId,
            `${versionA}|mapped|b:branch%2Fchild|i:loop%3A1`,
          ],
        ),
      ),
    ).resolves.toBeDefined();

    for (const malformed of [
      `|manual|b:|i:`,
      `${versionA}|manual|b:raw/path|i:`,
      `${versionA}|manual|b:|i:loop%3a1`,
      `${versionA}|manual|b:|i:loop:1`,
      `${versionA}|manual|b:|i:|extra`,
      `${versionA}|mánuál|b:|i:`,
    ]) {
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `insert into app.node_runs (
               id,workspace_id,workflow_run_id,node_id,invocation_key,
               branch_context,status,side_effect_class
             ) values ($1,$2,$3,'manual',$4,'{}'::jsonb,'pending','safe')`,
            [randomUUID(), workspaceA, runId, malformed],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }

    const readinessPool = new Pool({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
    });
    await asOwner(workspaceA, (client) =>
      client.query(
        `alter table app.node_runs
           drop constraint node_runs_invocation_key_format,
           add constraint node_runs_invocation_key_format
             check (length(invocation_key) > 0)`,
      ),
    );
    try {
      await expect(
        checkDatabaseReadiness(readinessPool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).rejects.toThrow('Coordinator RunStore grants are incompatible');
    } finally {
      await asOwner(workspaceA, (client) =>
        client.query(
          `alter table app.node_runs
             drop constraint node_runs_invocation_key_format,
             add constraint node_runs_invocation_key_format check (
               invocation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$'
               or invocation_key ~ '^([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})+\\|([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})+\\|b:([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})*\\|i:([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})*$'
             )`,
        ),
      );
    }
    await expect(
      checkDatabaseReadiness(readinessPool, {
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    ).resolves.toMatchObject({
      migrationHead: '0056_workspace_purge_foundation.sql',
    });
    await readinessPool.end();
  });

  it('loads a valid revision-zero checkpoint at cursor two and enforces workspace RLS', async () => {
    const runId = await insertRun({});
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'ready',
      state: {
        runId,
        workflowVersionId: versionA,
        checkpoint: checkpoint({}),
        completedOutputs: [],
        observations: [],
      },
    });
    const foreignRun = await insertRun({
      workspaceId: workspaceB,
      workflowId: workflowB,
      workflowVersionId: versionB,
      schedulerState: checkpoint({ workflowVersionId: versionB }),
    });
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId: foreignRun,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'not_found' });
  });

  it('fails closed when checkpoint invocations diverge from physical node state without new facts', async () => {
    const missingInvocationKey = 'version-a/missing-physical-node';
    const missingRun = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey: missingInvocationKey,
            nodeId: 'missing-physical-node',
            status: 'ready',
            attemptNumber: 0,
          },
        ],
        readySet: [missingInvocationKey],
      }),
      status: 'running',
    });
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId: missingRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);

    const invocationKey = 'version-a/contradictory-physical-node';
    const contradictoryRun = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'contradictory-physical-node',
            status: 'ready',
            attemptNumber: 0,
          },
        ],
        readySet: [invocationKey],
      }),
      status: 'running',
    });
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,
           branch_context,status,side_effect_class
         ) values ($1,$2,$3,'contradictory-physical-node',$4,'{}','pending','safe')`,
        [randomUUID(), workspaceA, contradictoryRun, invocationKey],
      ),
    );
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId: contradictoryRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });

  it('maps ordered started and terminal facts using exact physical attempt ownership', async () => {
    const invocationKey = 'version-a/manual';
    const state = checkpoint({
      runStatus: 'running',
      invocations: [
        {
          invocationKey,
          nodeId: 'manual',
          status: 'running',
          attemptNumber: 1,
        },
      ],
    });
    const runId = await insertRun({ schedulerState: state, status: 'running' });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,current_attempt_id,current_attempt_number,output_ref
         ) values ($1,$2,$3,'manual',$4,'{}','succeeded','safe',$5,1,$6::jsonb)`,
        [
          nodeRunId,
          workspaceA,
          runId,
          invocationKey,
          attemptId,
          JSON.stringify({
            schemaVersion: 1,
            kind: 'inline',
            value: { selectedPort: 'true' },
          }),
        ],
      );
      await client.query(
        `insert into app.node_attempts (
           id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
         ) values ($1,$2,$3,1,'succeeded','safe',$4::jsonb)`,
        [
          attemptId,
          workspaceA,
          nodeRunId,
          JSON.stringify({
            schemaVersion: 1,
            kind: 'inline',
            value: { selectedPort: 'true' },
          }),
        ],
      );
      for (const [sequence, type] of [
        [2, 'node.started'],
        [3, 'node.succeeded'],
      ] as const)
        await client.query(
          `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,$3,$4,$5::jsonb)`,
          [
            workspaceA,
            runId,
            sequence,
            type,
            JSON.stringify({ schemaVersion: 1, nodeRunId, attemptId }),
          ],
        );
    });
    const loaded = await store.loadAdvanceState({
      workspaceId: workspaceA,
      runId,
      signal: new AbortController().signal,
    });
    expect(loaded).toMatchObject({ kind: 'ready' });
    if (loaded.kind !== 'ready') throw new Error('expected ready state');
    expect(loaded.state.observations).toEqual([
      expect.objectContaining({
        kind: 'cursor_only',
        eventName: 'node.started',
        sequence: 2,
        invocationKey,
        attemptId,
        attemptNumber: 1,
      }),
      expect.objectContaining({
        kind: 'outcome',
        sequence: 3,
        invocationKey,
        status: 'succeeded',
        output: { kind: 'inline', attemptId },
      }),
    ]);
    expect(loaded.state.completedOutputs).toEqual([
      {
        sequence: 3,
        invocationKey,
        attemptId,
        value: { selectedPort: 'true' },
      },
    ]);
  });

  it('rejects a lone started fact whose physical attempt is terminal', async () => {
    const invocationKey = 'version-a/lone-started';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'lone-started',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,current_attempt_id,current_attempt_number
         ) values ($1,$2,$3,'lone-started',$4,'{}','succeeded','safe',$5,1)`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId],
      );
      await client.query(
        `insert into app.node_attempts (
           id,workspace_id,node_run_id,attempt_number,status,side_effect_class
         ) values ($1,$2,$3,1,'succeeded','safe')`,
        [attemptId, workspaceA, nodeRunId],
      );
      await client.query(
        `insert into app.run_events
           (workspace_id,workflow_run_id,sequence,type,payload)
         values ($1,$2,2,'node.started',$3::jsonb)`,
        [
          workspaceA,
          runId,
          JSON.stringify({ schemaVersion: 1, nodeRunId, attemptId }),
        ],
      );
    });
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });

  it('loads the exact ten-thousand cursor-fact boundary in one bounded pass', async () => {
    const invocationKey = 'cursor/boundary';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'boundary',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,current_attempt_id,current_attempt_number
         ) values ($1,$2,$3,'boundary',$4,'{}','running','safe',$5,1)`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId],
      );
      await client.query(
        `insert into app.node_attempts (
           id,workspace_id,node_run_id,attempt_number,status,side_effect_class
         ) values ($1,$2,$3,1,'running','safe')`,
        [attemptId, workspaceA, nodeRunId],
      );
      await client.query(
        `insert into app.run_events (
           workspace_id,workflow_run_id,sequence,type,payload
         )
         select $1,$2,sequence,
                case when sequence=2 then 'node.started' else 'node.progress' end,
                $3::jsonb
         from generate_series(2,10001) sequence`,
        [
          workspaceA,
          runId,
          JSON.stringify({ schemaVersion: 1, nodeRunId, attemptId }),
        ],
      );
    });
    const loaded = await store.loadAdvanceState({
      workspaceId: workspaceA,
      runId,
      signal: new AbortController().signal,
    });
    expect(loaded).toMatchObject({ kind: 'ready' });
    if (loaded.kind !== 'ready') throw new Error('expected ready state');
    expect(loaded.state.observations).toHaveLength(10_000);
    expect(loaded.state.observations[0]).toMatchObject({
      kind: 'cursor_only',
      eventName: 'node.started',
      sequence: 2,
      invocationKey,
      attemptNumber: 1,
    });
    expect(loaded.state.observations.at(-1)).toMatchObject({
      kind: 'cursor_only',
      eventName: 'node.progress',
      sequence: 10_001,
      invocationKey,
      attemptNumber: 1,
    });
  }, 30_000);

  it('fails closed for event gaps and corrupt physical event identities', async () => {
    const gapRun = await insertRun({});
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.run_events
           (workspace_id,workflow_run_id,sequence,type,payload)
         values ($1,$2,3,'run.cancel_requested','{"schemaVersion":1}')`,
        [workspaceA, gapRun],
      ),
    );
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId: gapRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);

    const unversionedRun = await insertRun({});
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.run_events
           (workspace_id,workflow_run_id,sequence,type,payload)
         values ($1,$2,2,'run.cancel_requested','{}'::jsonb)`,
        [workspaceA, unversionedRun],
      ),
    );
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId: unversionedRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);

    const corruptRun = await insertRun({
      schedulerState: checkpoint({ runStatus: 'running' }),
      status: 'running',
    });
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.run_events
           (workspace_id,workflow_run_id,sequence,type,payload)
         values ($1,$2,2,'node.started',$3::jsonb)`,
        [
          workspaceA,
          corruptRun,
          JSON.stringify({
            schemaVersion: 1,
            nodeRunId: randomUUID(),
            attemptId: randomUUID(),
          }),
        ],
      ),
    );
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId: corruptRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });

  it('rejects oversized persisted facts without materializing an oversized batch', async () => {
    const oversizedRun = await insertRun({});
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.run_events
           (workspace_id,workflow_run_id,sequence,type,payload)
         values ($1,$2,2,'run.cancel_requested',
           jsonb_build_object('schemaVersion',1,'ignored',repeat('x',100000)))`,
        [workspaceA, oversizedRun],
      ),
    );
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId: oversizedRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: oversizedRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 2,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 4,
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'run.started',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);

    const aggregateRun = await insertRun({});
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.run_events
           (workspace_id,workflow_run_id,sequence,type,payload)
         select $1,$2,sequence,'run.cancel_requested',
                jsonb_build_object(
                  'schemaVersion',1,'ignored',repeat('x',520000)
                )
         from generate_series(2,131) sequence`,
        [workspaceA, aggregateRun],
      ),
    );
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId: aggregateRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: aggregateRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 131,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 133,
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 132,
              name: 'run.started',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });

  it('chunk-loads application-valid facts beyond 64 MiB of PostgreSQL text expansion', async () => {
    const invocationKey = 'version-a/exponent-heavy-progress';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        admittedInvocationKeys: [invocationKey],
        invocations: [
          {
            invocationKey,
            nodeId: 'exponent-heavy-progress',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    const storageBytes = await asRuntime(
      workerBaseUrl,
      workspaceA,
      async (client) => {
        await client.query(
          `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,
             branch_context,status,side_effect_class,current_attempt_id,
             current_attempt_number
           ) values ($1,$2,$3,'exponent-heavy-progress',$4,'{}','running',
                     'safe',$5,1)`,
          [nodeRunId, workspaceA, runId, invocationKey, attemptId],
        );
        await client.query(
          `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class
           ) values ($1,$2,$3,1,'running','safe')`,
          [attemptId, workspaceA, nodeRunId],
        );
        await client.query(
          `with numbers as (
             select jsonb_agg(1e308::numeric) as value
             from generate_series(1,500)
           )
           insert into app.run_events (
             workspace_id,workflow_run_id,sequence,type,payload
           )
           select $1,$2,sequence,'node.progress',jsonb_build_object(
             'schemaVersion',1,'nodeRunId',$3::text,'attemptId',$4::text,
             'numbers',numbers.value
           )
           from generate_series(2,451) sequence cross join numbers`,
          [workspaceA, runId, nodeRunId, attemptId],
        );
        const size = await client.query<{ bytes: string }>(
          `select sum(octet_length(payload::text))::bigint as bytes
           from app.run_events
           where workspace_id=$1 and workflow_run_id=$2 and sequence >= 2`,
          [workspaceA, runId],
        );
        return Number(size.rows[0]?.bytes);
      },
    );
    expect(storageBytes).toBeGreaterThan(64 * 1024 * 1024);

    const loaded = await store.loadAdvanceState({
      workspaceId: workspaceA,
      runId,
      signal: new AbortController().signal,
    });
    expect(loaded).toMatchObject({ kind: 'ready' });
    if (loaded.kind !== 'ready') throw new Error('expected ready state');
    expect(loaded.state.observations).toHaveLength(450);
    expect(loaded.state.observations.at(0)).toMatchObject({ sequence: 2 });
    expect(loaded.state.observations.at(-1)).toMatchObject({ sequence: 451 });

    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 451,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 452,
            admittedInvocationKeys: [invocationKey],
            invocations: [
              {
                invocationKey,
                nodeId: 'exponent-heavy-progress',
                status: 'running',
                attemptNumber: 1,
              },
            ],
          }),
          events: [],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
  });

  it('fails closed for started and terminal physical status or output divergence', async () => {
    for (const variant of [
      {
        name: 'started-status',
        eventType: 'node.started',
        nodeStatus: 'running',
        attemptStatus: 'succeeded',
        nodeValue: null,
        attemptValue: null,
      },
      {
        name: 'progress-status',
        eventType: 'node.progress',
        nodeStatus: 'failed',
        attemptStatus: 'succeeded',
        nodeValue: null,
        attemptValue: null,
      },
      {
        name: 'terminal-status',
        eventType: 'node.succeeded',
        nodeStatus: 'running',
        attemptStatus: 'succeeded',
        nodeValue: { schemaVersion: 1, kind: 'inline', value: { ok: true } },
        attemptValue: {
          schemaVersion: 1,
          kind: 'inline',
          value: { ok: true },
        },
      },
      {
        name: 'terminal-output',
        eventType: 'node.succeeded',
        nodeStatus: 'succeeded',
        attemptStatus: 'succeeded',
        nodeValue: {
          schemaVersion: 1,
          kind: 'inline',
          value: { side: 'node' },
        },
        attemptValue: {
          schemaVersion: 1,
          kind: 'inline',
          value: { side: 'attempt' },
        },
      },
    ] as const) {
      const invocationKey = `physical/${variant.name}`;
      const runId = await insertRun({
        schedulerState: checkpoint({
          runStatus: 'running',
          invocations: [
            {
              invocationKey,
              nodeId: variant.name,
              status: 'running',
              attemptNumber: 1,
            },
          ],
        }),
        status: 'running',
      });
      const nodeRunId = randomUUID();
      const attemptId = randomUUID();
      await asRuntime(workerBaseUrl, workspaceA, async (client) => {
        await client.query(
          `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number,output_ref
           ) values ($1,$2,$3,$4,$5,'{}',$6,'safe',$7,1,$8::jsonb)`,
          [
            nodeRunId,
            workspaceA,
            runId,
            variant.name,
            invocationKey,
            variant.nodeStatus,
            attemptId,
            variant.nodeValue === null
              ? null
              : JSON.stringify(variant.nodeValue),
          ],
        );
        await client.query(
          `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
           ) values ($1,$2,$3,1,$4,'safe',$5::jsonb)`,
          [
            attemptId,
            workspaceA,
            nodeRunId,
            variant.attemptStatus,
            variant.attemptValue === null
              ? null
              : JSON.stringify(variant.attemptValue),
          ],
        );
        await client.query(
          `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,2,$3,$4::jsonb)`,
          [
            workspaceA,
            runId,
            variant.eventType,
            JSON.stringify({ schemaVersion: 1, nodeRunId, attemptId }),
          ],
        );
      });
      await expect(
        store.loadAdvanceState({
          workspaceId: workspaceA,
          runId,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    }
  });

  it('fails closed for a terminal fact whose stored output is not a tagged execution value', async () => {
    const invocationKey = 'version-a/corrupt-output';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'corrupt-output',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,current_attempt_id,current_attempt_number
         ) values ($1,$2,$3,'corrupt-output',$4,'{}','succeeded','safe',$5,1)`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId],
      );
      await client.query(
        `insert into app.node_attempts (
           id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
         ) values ($1,$2,$3,1,'succeeded','safe','{"kind":"inline"}'::jsonb)`,
        [attemptId, workspaceA, nodeRunId],
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

    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });

  it('fails closed when a terminal artifact locator is not available in the run workspace', async () => {
    const invocationKey = 'version-a/artifact';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'artifact',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    const artifactId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceB, async (client) => {
      await client.query(
        `insert into app.artifacts (
           id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
           status,expires_at,finalized_at
         ) values ($1,$2,'node-output',$3,'application/json',1,$4,
           'available',now()+interval '1 day',now())`,
        [
          artifactId,
          workspaceB,
          `workspaces/${workspaceB}/artifacts/${artifactId}`,
          'a'.repeat(64),
        ],
      );
    });
    await expect(
      asRuntime(workerBaseUrl, workspaceA, async (client) => {
        await client.query(
          `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,current_attempt_id,current_attempt_number
          ) values ($1,$2,$3,'artifact',$4,'{}','succeeded','safe',$5,1)`,
          [nodeRunId, workspaceA, runId, invocationKey, attemptId],
        );
        await client.query(
          `insert into app.node_attempts (
           id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
          ) values ($1,$2,$3,1,'succeeded','safe',$4::jsonb)`,
          [
            attemptId,
            workspaceA,
            nodeRunId,
            JSON.stringify({ schemaVersion: 1, kind: 'artifact', artifactId }),
          ],
        );
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('derives deadline and due observations from durable database truth', async () => {
    const invocationKey = 'version-a/waiting';
    const deadlineAt = new Date(Date.now() + 100).toISOString();
    const dueAt = '2020-01-01T00:01:00.000Z';
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    const runId = await insertRun({
      deadlineAt,
      schedulerState: checkpoint({
        runStatus: 'waiting',
        invocations: [
          {
            invocationKey,
            nodeId: 'waiting',
            status: 'waiting',
            attemptNumber: 1,
            resumeAt: dueAt,
            waitKind: 'node_wait',
          },
        ],
      }),
      status: 'waiting',
    });
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,current_attempt_id,current_attempt_number,resume_at,wait_kind
         ) values ($1,$2,$3,'waiting',$4,'{}','waiting','safe',$5,1,$6,'node_wait')`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId, dueAt],
      );
      await client.query(
        `insert into app.node_attempts (
           id,workspace_id,node_run_id,attempt_number,status,side_effect_class
         ) values ($1,$2,$3,1,'succeeded','safe')`,
        [attemptId, workspaceA, nodeRunId],
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const loaded = await store.loadAdvanceState({
      workspaceId: workspaceA,
      runId,
      signal: new AbortController().signal,
    });
    expect(loaded).toMatchObject({ kind: 'ready' });
    if (loaded.kind !== 'ready') throw new Error('expected ready state');
    expect(loaded.state.observations).toEqual([
      { kind: 'deadline_expired', occurredAt: deadlineAt },
      { kind: 'due_at', invocationKey, occurredAt: dueAt },
    ]);
  });

  it('commits a terminal fact only when checkpoint output ownership is exact', async () => {
    const invocationKey = 'terminal/inline';
    const current = checkpoint({
      runStatus: 'running',
      invocations: [
        {
          invocationKey,
          nodeId: 'inline',
          status: 'running',
          attemptNumber: 1,
        },
      ],
    });
    const runId = await insertRun({
      schedulerState: current,
      status: 'running',
    });
    const { attemptId } = await seedSucceededFact(runId, invocationKey, {
      schemaVersion: 1,
      kind: 'inline',
      value: { ok: true },
    });
    const terminalPlan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 2,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'succeeded',
        nextEventSequence: 4,
        invocations: [
          {
            invocationKey,
            nodeId: 'inline',
            status: 'succeeded',
            attemptNumber: 1,
            output: { kind: 'inline', attemptId },
          },
        ],
      }),
      events: [
        {
          schemaVersion: 1,
          sequence: 3,
          name: 'run.succeeded',
          occurredAt: '2026-08-21T00:00:00.000Z',
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    } as const;
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: terminalPlan,
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });

    const wrongInlineRun = await insertRun({
      schedulerState: current,
      status: 'running',
    });
    await seedSucceededFact(wrongInlineRun, invocationKey, {
      schemaVersion: 1,
      kind: 'inline',
      value: { ok: true },
    });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: wrongInlineRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          ...terminalPlan,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'succeeded',
            nextEventSequence: 4,
            invocations: [
              {
                invocationKey,
                nodeId: 'inline',
                status: 'succeeded',
                attemptNumber: 1,
                output: { kind: 'inline', attemptId: randomUUID() },
              },
            ],
          }),
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);

    const immutableRun = await insertRun({});
    const immutableBase = checkpoint({
      revision: 1,
      runStatus: 'running',
      nextEventSequence: 3,
    });
    for (const mutatedCheckpoint of [
      { ...immutableBase, engineVersion: 'engine-v2' },
      { ...immutableBase, remainingIterationBudget: 1 },
    ]) {
      await expect(
        store.commitAdvancePlan({
          workspaceId: workspaceA,
          runId: immutableRun,
          workflowVersionId: versionA,
          signal: new AbortController().signal,
          plan: {
            expectedRevision: 0,
            expectedNextEventSequence: 2,
            consumedThroughEventSequence: 1,
            checkpoint: mutatedCheckpoint,
            events: [
              {
                schemaVersion: 1,
                sequence: 2,
                name: 'run.started',
                occurredAt: '2026-08-21T00:00:00.000Z',
              },
            ],
            nodeRunAdmissions: [],
            attempts: [],
          },
        }),
      ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
    }

    const artifactId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceB, (client) =>
      client.query(
        `insert into app.artifacts (
           id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
           status,expires_at,finalized_at
         ) values ($1,$2,'node-output',$3,'application/json',1,$4,
           'available',now()+interval '1 day',now())`,
        [
          artifactId,
          workspaceB,
          `workspaces/${workspaceB}/artifacts/${artifactId}`,
          'b'.repeat(64),
        ],
      ),
    );
    const artifactInvocation = 'terminal/artifact';
    const artifactCurrent = checkpoint({
      runStatus: 'running',
      invocations: [
        {
          invocationKey: artifactInvocation,
          nodeId: 'artifact',
          status: 'running',
          attemptNumber: 1,
        },
      ],
    });
    const artifactRun = await insertRun({
      schedulerState: artifactCurrent,
      status: 'running',
    });
    await expect(
      seedSucceededFact(artifactRun, artifactInvocation, {
        schemaVersion: 1,
        kind: 'artifact',
        artifactId,
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('waits for artifact invalidation and rejects the now-unavailable checkpoint output', async () => {
    const artifactId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.artifacts (
           id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
           status,expires_at,finalized_at
         ) values ($1,$2,'node-output',$3,'application/json',1,$4,
           'available',now()+interval '1 day',now())`,
        [
          artifactId,
          workspaceA,
          `workspaces/${workspaceA}/artifacts/${artifactId}`,
          'c'.repeat(64),
        ],
      ),
    );
    const invocationKey = 'terminal/artifact-race';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'artifact-race',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    await seedSucceededFact(runId, invocationKey, {
      schemaVersion: 1,
      kind: 'artifact',
      artifactId,
    });
    const invalidator = new Pool({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
    });
    try {
      await invalidator.query('begin');
      await invalidator.query(
        "select set_config('app.workspace_id', $1, true)",
        [workspaceA],
      );
      await invalidator.query(
        `update app.artifacts set status='deleting' where id=$1`,
        [artifactId],
      );
      const commit = store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 2,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'succeeded',
            nextEventSequence: 4,
            invocations: [
              {
                invocationKey,
                nodeId: 'artifact-race',
                status: 'succeeded',
                attemptNumber: 1,
                output: { kind: 'artifact', artifactId },
              },
            ],
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'run.succeeded',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      });
      let settled = false;
      void commit.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      await invalidator.query('commit');
      await expect(commit).rejects.toBeInstanceOf(
        CoordinatorRunStateCorruptError,
      );
    } finally {
      await invalidator.query('rollback').catch(() => undefined);
      await invalidator.end();
    }
  });

  it('atomically commits exact events, all logical rows, an attempt subset, and IDs-only outbox', async () => {
    const runId = await insertRun({});
    const invocationA = 'version-a/a';
    const invocationB = 'version-a/b';
    const next = checkpoint({
      revision: 1,
      runStatus: 'running',
      nextEventSequence: 5,
      readySet: [invocationB],
      admittedInvocationKeys: [invocationA],
      invocations: [
        {
          invocationKey: invocationA,
          nodeId: 'a',
          status: 'running',
          attemptNumber: 1,
        },
        {
          invocationKey: invocationB,
          nodeId: 'b',
          status: 'ready',
          attemptNumber: 0,
        },
      ],
    });
    const result = await store.commitAdvancePlan({
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan: {
        expectedRevision: 0,
        expectedNextEventSequence: 2,
        consumedThroughEventSequence: 1,
        checkpoint: next,
        events: [
          {
            schemaVersion: 1,
            sequence: 2,
            name: 'run.started',
            occurredAt: '2026-08-21T00:00:00.000Z',
          },
          {
            schemaVersion: 1,
            sequence: 3,
            name: 'node.ready',
            occurredAt: '2026-08-21T00:00:00.000Z',
            invocationKey: invocationA,
            nodeId: 'a',
            attemptNumber: 0,
          },
          {
            schemaVersion: 1,
            sequence: 4,
            name: 'node.ready',
            occurredAt: '2026-08-21T00:00:00.000Z',
            invocationKey: invocationB,
            nodeId: 'b',
            attemptNumber: 0,
          },
        ],
        nodeRunAdmissions: [
          { invocationKey: invocationA, nodeId: 'a', sideEffectClass: 'safe' },
          { invocationKey: invocationB, nodeId: 'b', sideEffectClass: 'safe' },
        ],
        attempts: [
          {
            invocationKey: invocationA,
            nodeId: 'a',
            attemptNumber: 1,
            sideEffectClass: 'safe',
          },
        ],
      },
    });
    expect(result).toMatchObject({ kind: 'committed', revision: 1 });
    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        event_sequences: number[];
        node_count: number;
        attempt_count: number;
        outbox_count: number;
        payload_keys: string[];
        engine_node_events_valid: boolean;
      }>(
        `select
           (select array_agg(sequence order by sequence) from app.run_events where workflow_run_id=$1) event_sequences,
           (select count(*)::int from app.node_runs where workflow_run_id=$1) node_count,
           (select count(*)::int from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id where node.workflow_run_id=$1) attempt_count,
           (select count(*)::int from app.outbox_events where job_name='execute-node-attempt' and payload->>'runId'=$1::text) outbox_count,
           (select array_agg(key order by key) from app.outbox_events, lateral jsonb_object_keys(payload) key where job_name='execute-node-attempt' and payload->>'runId'=$1::text) payload_keys,
           (select count(*)=2 and bool_and(
              payload->>'schemaVersion'='1'
              and payload->>'invocationKey' in ($2,$3)
              and payload->>'nodeId' in ('a','b')
              and (payload->>'attemptNumber')::int =
                0
              and payload ? 'nodeRunId'
              and not (payload ? 'attemptId')
            ) from app.run_events
            where workflow_run_id=$1 and type='node.ready') engine_node_events_valid`,
        [runId, invocationA, invocationB],
      ),
    );
    expect(proof.rows[0]).toEqual({
      event_sequences: [1, 2, 3, 4],
      node_count: 2,
      attempt_count: 1,
      outbox_count: 1,
      payload_keys: [
        'attemptId',
        'nodeRunId',
        'outboxEventId',
        'runId',
        'schemaVersion',
        'workspaceId',
      ],
      engine_node_events_valid: true,
    });
  });

  it('commits persisted retry facts and admits only database-due retries', async () => {
    for (const due of ['past', 'future'] as const) {
      const invocationKey = `retry/${due}`;
      const dueAt =
        due === 'past'
          ? '2020-01-01T00:00:00.000Z'
          : '2099-01-01T00:00:00.000Z';
      const runId = await insertRun({
        schedulerState: checkpoint({
          runStatus: 'running',
          invocations: [
            {
              invocationKey,
              nodeId: due,
              status: 'running',
              attemptNumber: 1,
            },
          ],
        }),
        status: 'running',
      });
      const nodeRunId = randomUUID();
      const attemptId = randomUUID();
      await asRuntime(workerBaseUrl, workspaceA, async (client) => {
        await client.query(
          `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number,retry_due_at,wait_kind
           ) values ($1,$2,$3,$4,$5,'{}','waiting','safe',$6,1,$7,'retry_backoff')`,
          [nodeRunId, workspaceA, runId, due, invocationKey, attemptId, dueAt],
        );
        await client.query(
          `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class
           ) values ($1,$2,$3,1,'failed','safe')`,
          [attemptId, workspaceA, nodeRunId],
        );
        await client.query(
          `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,2,'node.retry_scheduled',$3::jsonb)`,
          [
            workspaceA,
            runId,
            JSON.stringify({
              schemaVersion: 1,
              nodeRunId,
              attemptId,
              dueAt,
            }),
          ],
        );
      });
      const fresh = await store.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      });
      expect(fresh).toMatchObject({ kind: 'ready' });
      if (fresh.kind !== 'ready') throw new Error('expected ready state');
      expect(fresh.state.observations).toEqual([
        expect.objectContaining({
          kind: 'wait',
          eventName: 'node.retry_scheduled',
          sequence: 2,
          invocationKey,
          attemptNumber: 1,
          resumeAt: dueAt,
        }),
      ]);
      const waitingCheckpoint = checkpoint({
        revision: 1,
        runStatus: 'waiting',
        nextEventSequence: 4,
        invocations: [
          {
            invocationKey,
            nodeId: due,
            status: 'waiting',
            attemptNumber: 1,
            resumeAt: dueAt,
            waitKind: 'retry_backoff',
          },
        ],
      });
      await expect(
        store.commitAdvancePlan({
          workspaceId: workspaceA,
          runId,
          workflowVersionId: versionA,
          signal: new AbortController().signal,
          plan: {
            expectedRevision: 0,
            expectedNextEventSequence: 2,
            consumedThroughEventSequence: 2,
            checkpoint: waitingCheckpoint,
            events: [
              {
                schemaVersion: 1,
                sequence: 3,
                name: 'run.waiting',
                occurredAt: '2026-08-21T00:00:00.000Z',
              },
            ],
            nodeRunAdmissions: [],
            attempts: [],
          },
        }),
      ).resolves.toMatchObject({ kind: 'committed', revision: 1 });

      const afterWaiting = await store.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      });
      expect(afterWaiting).toMatchObject({ kind: 'ready' });
      if (afterWaiting.kind !== 'ready')
        throw new Error('expected ready state');
      expect(afterWaiting.state.observations).toEqual(
        due === 'past'
          ? [{ kind: 'due_at', invocationKey, occurredAt: dueAt }]
          : [],
      );

      const retryPlan = {
        expectedRevision: 1,
        expectedNextEventSequence: 4,
        consumedThroughEventSequence: 3,
        checkpoint: checkpoint({
          revision: 2,
          runStatus: 'running',
          nextEventSequence: 5,
          admittedInvocationKeys: [invocationKey],
          invocations: [
            {
              invocationKey,
              nodeId: due,
              status: 'running',
              attemptNumber: 2,
            },
          ],
        }),
        events: [
          {
            schemaVersion: 1,
            sequence: 4,
            name: 'node.ready',
            occurredAt: '2026-08-21T00:00:00.000Z',
            invocationKey,
            nodeId: due,
            attemptNumber: 1,
          },
        ],
        nodeRunAdmissions: [],
        attempts: [
          {
            invocationKey,
            nodeId: due,
            attemptNumber: 2,
            sideEffectClass: 'safe',
          },
        ],
      } as const;
      const retry = store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: retryPlan,
      });
      if (due === 'past')
        await expect(retry).resolves.toMatchObject({
          kind: 'committed',
          revision: 2,
        });
      else
        await expect(retry).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
    }
  });

  it('rejects plans that consume terminal or retry facts without applying their semantics', async () => {
    const terminalInvocation = 'ignored/terminal';
    const terminalRun = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey: terminalInvocation,
            nodeId: 'terminal',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    await seedSucceededFact(terminalRun, terminalInvocation, {
      schemaVersion: 1,
      kind: 'inline',
      value: { ok: true },
    });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: terminalRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 2,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 3,
            invocations: [
              {
                invocationKey: terminalInvocation,
                nodeId: 'terminal',
                status: 'running',
                attemptNumber: 1,
              },
            ],
          }),
          events: [],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);

    const retryInvocation = 'ignored/retry';
    const retryRun = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey: retryInvocation,
            nodeId: 'retry',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    const dueAt = '2099-01-01T00:00:00.000Z';
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,current_attempt_id,current_attempt_number,retry_due_at
         ) values ($1,$2,$3,'retry',$4,'{}','waiting','safe',$5,1,$6)`,
        [nodeRunId, workspaceA, retryRun, retryInvocation, attemptId, dueAt],
      );
      await client.query(
        `insert into app.node_attempts (
           id,workspace_id,node_run_id,attempt_number,status,side_effect_class
         ) values ($1,$2,$3,1,'failed','safe')`,
        [attemptId, workspaceA, nodeRunId],
      );
      await client.query(
        `insert into app.run_events
           (workspace_id,workflow_run_id,sequence,type,payload)
         values ($1,$2,2,'node.retry_scheduled',$3::jsonb)`,
        [
          workspaceA,
          retryRun,
          JSON.stringify({
            schemaVersion: 1,
            nodeRunId,
            attemptId,
            dueAt,
          }),
        ],
      );
    });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: retryRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 2,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 3,
            invocations: [
              {
                invocationKey: retryInvocation,
                nodeId: 'retry',
                status: 'running',
                attemptNumber: 1,
              },
            ],
          }),
          events: [],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
  });

  it('commits a persisted wait fact using its physical attempt fence', async () => {
    const invocationKey = 'wait/persisted';
    const resumeAt = '2099-01-01T00:00:00.000Z';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'persisted',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,current_attempt_id,current_attempt_number,resume_at
         ) values ($1,$2,$3,'persisted',$4,'{}','waiting','safe',$5,1,$6)`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId, resumeAt],
      );
      await client.query(
        `insert into app.node_attempts (
           id,workspace_id,node_run_id,attempt_number,status,side_effect_class
         ) values ($1,$2,$3,1,'succeeded','safe')`,
        [attemptId, workspaceA, nodeRunId],
      );
      await client.query(
        `insert into app.run_events
           (workspace_id,workflow_run_id,sequence,type,payload)
         values ($1,$2,2,'node.waiting',$3::jsonb)`,
        [
          workspaceA,
          runId,
          JSON.stringify({
            schemaVersion: 1,
            nodeRunId,
            attemptId,
            dueAt: resumeAt,
          }),
        ],
      );
    });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 2,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'waiting',
            nextEventSequence: 4,
            invocations: [
              {
                invocationKey,
                nodeId: 'persisted',
                status: 'waiting',
                attemptNumber: 1,
                resumeAt,
              },
            ],
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'run.waiting',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
  });

  it('persists more than sixty-four due waiting-to-ready recoveries without admitting attempts', async () => {
    const dueAt = '2020-01-01T00:00:00.000Z';
    const invocations = Array.from({ length: 65 }, (_, index) => ({
      invocationKey: `bulk-due/${String(index).padStart(2, '0')}`,
      nodeId: `node-${String(index).padStart(2, '0')}`,
      status: 'waiting' as const,
      attemptNumber: 1,
      resumeAt: dueAt,
    }));
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'waiting',
        invocations,
      }),
      status: 'waiting',
    });
    const physicalNodeIds = invocations.map(() => randomUUID());
    const physicalAttemptIds = invocations.map(() => randomUUID());
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,current_attempt_id,current_attempt_number,resume_at
         )
         select physical_id,$1,$2,node_id,invocation_key,'{}','waiting','safe',attempt_id,1,$3
         from unnest($4::uuid[],$5::uuid[],$6::varchar[],$7::varchar[])
           as due(physical_id,attempt_id,invocation_key,node_id)`,
        [
          workspaceA,
          runId,
          dueAt,
          physicalNodeIds,
          physicalAttemptIds,
          invocations.map(({ invocationKey }) => invocationKey),
          invocations.map(({ nodeId }) => nodeId),
        ],
      );
      await client.query(
        `insert into app.node_attempts (
           id,workspace_id,node_run_id,attempt_number,status,side_effect_class
         )
         select attempt_id,$1,node_run_id,1,'failed','safe'
         from unnest($2::uuid[],$3::uuid[]) as attempt(attempt_id,node_run_id)`,
        [workspaceA, physicalAttemptIds, physicalNodeIds],
      );
    });
    const events = [
      ...invocations.map((invocation, index) => ({
        schemaVersion: 1 as const,
        sequence: index + 2,
        name: 'node.ready' as const,
        occurredAt: '2026-08-21T00:00:00.000Z',
        invocationKey: invocation.invocationKey,
        nodeId: invocation.nodeId,
        attemptNumber: 1,
      })),
    ];
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'waiting',
            nextEventSequence: 67,
            readySet: invocations.map(({ invocationKey }) => invocationKey),
            invocations: invocations.map((value) => ({
              invocationKey: value.invocationKey,
              nodeId: value.nodeId,
              status: 'ready' as const,
              attemptNumber: value.attemptNumber,
            })),
          }),
          events,
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        due_payloads_valid: boolean;
        new_attempts: number;
        ready: number;
      }>(
        `select
           (select count(*)::int from app.node_runs where workflow_run_id=$1 and status='ready') ready,
           (select count(*)::int from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id where node.workflow_run_id=$1 and attempt.attempt_number > 1) new_attempts,
           (select count(*)=65 and bool_and(
              payload->>'schemaVersion'='1'
              and (payload->>'attemptNumber')::int=1
              and payload ? 'nodeRunId' and payload ? 'attemptId'
            ) from app.run_events where workflow_run_id=$1 and type='node.ready') due_payloads_valid`,
        [runId],
      ),
    );
    expect(proof.rows[0]).toEqual({
      ready: 65,
      new_attempts: 0,
      due_payloads_valid: true,
    });
  });

  it('has one concurrent CAS winner and classifies the exact replay', async () => {
    const runId = await insertRun({});
    const next = checkpoint({
      revision: 1,
      runStatus: 'running',
      nextEventSequence: 3,
    });
    const input = {
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan: {
        expectedRevision: 0,
        expectedNextEventSequence: 2,
        consumedThroughEventSequence: 1,
        checkpoint: next,
        events: [
          {
            schemaVersion: 1,
            sequence: 2,
            name: 'run.started',
            occurredAt: '2026-08-21T00:00:00.000Z',
          },
        ],
        nodeRunAdmissions: [],
        attempts: [],
      },
    } as const;
    const raced = await Promise.all([
      store.commitAdvancePlan(input),
      store.commitAdvancePlan(input),
    ]);
    expect(raced.map(({ kind }) => kind).sort()).toEqual([
      'already_committed',
      'committed',
    ]);
    await expect(store.commitAdvancePlan(input)).resolves.toEqual({
      kind: 'already_committed',
      revision: 1,
    });
    const receipts = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ completed: number }>(
        `select count(*)::int completed
         from app.inbox_receipts receipt
         join app.outbox_events event on event.id=receipt.message_id
         where event.aggregate_id=$1 and receipt.completed_at is not null`,
        [runId],
      ),
    );
    expect(receipts.rows[0]?.completed).toBe(1);
  });

  it('uses the exact transition fingerprint for event and admission replays', async () => {
    const firstRun = await insertRun({});
    const basePlan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 3,
      }),
      events: [
        {
          schemaVersion: 1,
          sequence: 2,
          name: 'run.started',
          occurredAt: '2026-08-21T00:00:00.000Z',
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    } as const;
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: firstRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: basePlan,
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: firstRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          ...basePlan,
          events: [
            { ...basePlan.events[0], occurredAt: '2026-08-21T00:00:01.000Z' },
          ],
        },
      }),
    ).resolves.toEqual({ kind: 'stale', revision: 1 });

    const secondRun = await insertRun({});
    const invocationA = 'fingerprint/a';
    const invocationB = 'fingerprint/b';
    const admissions = [
      { invocationKey: invocationA, nodeId: 'a', sideEffectClass: 'safe' },
      { invocationKey: invocationB, nodeId: 'b', sideEffectClass: 'safe' },
    ] as const;
    const admissionPlan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 5,
        readySet: [invocationA, invocationB],
        invocations: [
          {
            invocationKey: invocationA,
            nodeId: 'a',
            status: 'ready',
            attemptNumber: 0,
          },
          {
            invocationKey: invocationB,
            nodeId: 'b',
            status: 'ready',
            attemptNumber: 0,
          },
        ],
      }),
      events: [
        {
          schemaVersion: 1,
          sequence: 2,
          name: 'run.started',
          occurredAt: '2026-08-21T00:00:00.000Z',
        },
        {
          schemaVersion: 1,
          sequence: 3,
          name: 'node.ready',
          occurredAt: '2026-08-21T00:00:00.000Z',
          invocationKey: invocationA,
          nodeId: 'a',
          attemptNumber: 0,
        },
        {
          schemaVersion: 1,
          sequence: 4,
          name: 'node.ready',
          occurredAt: '2026-08-21T00:00:00.000Z',
          invocationKey: invocationB,
          nodeId: 'b',
          attemptNumber: 0,
        },
      ],
      nodeRunAdmissions: admissions,
      attempts: [],
    } as const;
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: secondRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: admissionPlan,
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: secondRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          ...admissionPlan,
          nodeRunAdmissions: [admissions[1], admissions[0]],
        },
      }),
    ).resolves.toEqual({ kind: 'stale', revision: 1 });
  });

  it('rejects forged sticky facts, source-owned cancel events, and attempts after either sticky fact', async () => {
    const runId = await insertRun({});
    for (const sticky of ['cancelRequested', 'deadlineExpired'] as const) {
      await expect(
        store.commitAdvancePlan({
          workspaceId: workspaceA,
          runId,
          workflowVersionId: versionA,
          signal: new AbortController().signal,
          plan: {
            expectedRevision: 0,
            expectedNextEventSequence: 2,
            consumedThroughEventSequence: 1,
            checkpoint: checkpoint({
              revision: 1,
              nextEventSequence: 2,
              [sticky]: true,
            }),
            events: [],
            nodeRunAdmissions: [],
            attempts: [],
          },
        }),
      ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
    }
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: checkpoint({ revision: 1, nextEventSequence: 3 }),
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'run.cancel_requested',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
    for (const sticky of ['cancelRequested', 'deadlineExpired'] as const) {
      const invocationKey = `sticky/${sticky}`;
      await expect(
        store.commitAdvancePlan({
          workspaceId: workspaceA,
          runId,
          workflowVersionId: versionA,
          signal: new AbortController().signal,
          plan: {
            expectedRevision: 0,
            expectedNextEventSequence: 2,
            consumedThroughEventSequence: 1,
            checkpoint: checkpoint({
              revision: 1,
              runStatus: 'running',
              nextEventSequence: 4,
              [sticky]: true,
              admittedInvocationKeys: [invocationKey],
              invocations: [
                {
                  invocationKey,
                  nodeId: sticky,
                  status: 'running',
                  attemptNumber: 1,
                },
              ],
            }),
            events: [
              {
                schemaVersion: 1,
                sequence: 2,
                name: 'run.started',
                occurredAt: '2026-08-21T00:00:00.000Z',
              },
              {
                schemaVersion: 1,
                sequence: 3,
                name: 'node.ready',
                occurredAt: '2026-08-21T00:00:00.000Z',
                invocationKey,
                nodeId: sticky,
                attemptNumber: 0,
              },
            ],
            nodeRunAdmissions: [
              { invocationKey, nodeId: sticky, sideEffectClass: 'safe' },
            ],
            attempts: [
              {
                invocationKey,
                nodeId: sticky,
                attemptNumber: 1,
                sideEffectClass: 'safe',
              },
            ],
          },
        }),
      ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
    }
    const physical = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ attempts: number; nodes: number }>(
        `select
           (select count(*)::int from app.node_runs where workflow_run_id=$1) nodes,
           (select count(*)::int from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id where node.workflow_run_id=$1) attempts`,
        [runId],
      ),
    );
    expect(physical.rows[0]).toEqual({ nodes: 0, attempts: 0 });
  });

  it('requires exact old-to-new node-run and attempt admission deltas', async () => {
    const newInvocation = 'delta/new';
    const missingNodeRun = await insertRun({});
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: missingNodeRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 4,
            readySet: [newInvocation],
            invocations: [
              {
                invocationKey: newInvocation,
                nodeId: 'new',
                status: 'ready',
                attemptNumber: 0,
              },
            ],
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'run.started',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'node.ready',
              occurredAt: '2026-08-21T00:00:00.000Z',
              invocationKey: newInvocation,
              nodeId: 'new',
              attemptNumber: 0,
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);

    const existingInvocation = 'delta/existing';
    const missingAttempt = await insertRun({
      schedulerState: checkpoint({
        readySet: [existingInvocation],
        invocations: [
          {
            invocationKey: existingInvocation,
            nodeId: 'existing',
            status: 'ready',
            attemptNumber: 0,
          },
        ],
      }),
    });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: missingAttempt,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 3,
            admittedInvocationKeys: [existingInvocation],
            invocations: [
              {
                invocationKey: existingInvocation,
                nodeId: 'existing',
                status: 'running',
                attemptNumber: 1,
              },
            ],
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'run.started',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: missingAttempt,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 3,
            readySet: [existingInvocation],
            admittedInvocationKeys: [existingInvocation],
            invocations: [
              {
                invocationKey: existingInvocation,
                nodeId: 'existing',
                status: 'ready',
                attemptNumber: 0,
              },
            ],
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'run.started',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ nodes: number; revisions: number[] }>(
        `select
           (select count(*)::int from app.node_runs where workflow_run_id=any($1::uuid[])) nodes,
           (select array_agg(revision order by workflow_run_id) from app.run_checkpoints where workflow_run_id=any($1::uuid[])) revisions`,
        [[missingNodeRun, missingAttempt]],
      ),
    );
    expect(proof.rows[0]).toEqual({ nodes: 0, revisions: [0, 0] });
  });

  it('returns stale when cancellation or deadline changes after load even without attempts', async () => {
    for (const kind of ['cancel', 'deadline'] as const) {
      const runId = await insertRun({
        ...(kind === 'deadline'
          ? { deadlineAt: new Date(Date.now() + 100).toISOString() }
          : {}),
      });
      const next = checkpoint({
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 3,
      });
      await expect(
        store.loadAdvanceState({
          workspaceId: workspaceA,
          runId,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ kind: 'ready' });
      if (kind === 'cancel') {
        await asRuntime(apiBaseUrl, workspaceA, async (client) => {
          await client.query(
            `update app.workflow_runs set cancel_requested_at=now(), cancel_requested_by='test' where id=$1`,
            [runId],
          );
          await client.query(
            `insert into app.run_events (workspace_id,workflow_run_id,sequence,type,payload)
             values ($1,$2,2,'run.cancel_requested','{"schemaVersion":1}')`,
            [workspaceA, runId],
          );
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      await expect(
        store.commitAdvancePlan({
          workspaceId: workspaceA,
          runId,
          workflowVersionId: versionA,
          signal: new AbortController().signal,
          plan: {
            expectedRevision: 0,
            expectedNextEventSequence: 2,
            consumedThroughEventSequence: 1,
            checkpoint: next,
            events: [
              {
                schemaVersion: 1,
                sequence: 2,
                name: 'run.started',
                occurredAt: '2026-08-21T00:00:00.000Z',
              },
            ],
            nodeRunAdmissions: [],
            attempts: [],
          },
        }),
      ).resolves.toEqual({ kind: 'stale', revision: 0 });
    }
  });

  it('rolls back all writes when a late physical event membership check fails', async () => {
    const admitted = 'version-a/admitted';
    const ghost = 'version-a/ghost';
    const runId = await insertRun({
      schedulerState: checkpoint({
        readySet: [ghost],
        invocations: [
          {
            invocationKey: ghost,
            nodeId: 'ghost',
            status: 'ready',
            attemptNumber: 0,
          },
        ],
      }),
    });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 5,
            readySet: [],
            admittedInvocationKeys: [admitted],
            invocations: [
              {
                invocationKey: admitted,
                nodeId: 'admitted',
                status: 'running',
                attemptNumber: 1,
              },
              {
                invocationKey: ghost,
                nodeId: 'ghost',
                status: 'failed',
                attemptNumber: 0,
              },
            ],
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'run.started',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'node.ready',
              occurredAt: '2026-08-21T00:00:00.000Z',
              invocationKey: admitted,
              nodeId: 'admitted',
              attemptNumber: 0,
            },
            {
              schemaVersion: 1,
              sequence: 4,
              name: 'node.failed',
              occurredAt: '2026-08-21T00:00:00.000Z',
              invocationKey: ghost,
              nodeId: 'ghost',
              attemptNumber: 0,
            },
          ],
          nodeRunAdmissions: [
            {
              invocationKey: admitted,
              nodeId: 'admitted',
              sideEffectClass: 'safe',
            },
          ],
          attempts: [
            {
              invocationKey: admitted,
              nodeId: 'admitted',
              attemptNumber: 1,
              sideEffectClass: 'safe',
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    const counts = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        nodes: number;
        attempts: number;
        events: number;
        inbox: number;
        revision: number;
      }>(
        `select
           (select count(*)::int from app.node_runs where workflow_run_id=$1) nodes,
           (select count(*)::int from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id where node.workflow_run_id=$1) attempts,
           (select count(*)::int from app.run_events where workflow_run_id=$1) events,
           (select count(*)::int from app.inbox_receipts receipt
             join app.outbox_events event on event.id=receipt.message_id
             where event.aggregate_id=$1) inbox,
           (select revision from app.run_checkpoints where workflow_run_id=$1) revision`,
        [runId],
      ),
    );
    expect(counts.rows[0]).toEqual({
      nodes: 0,
      attempts: 0,
      events: 1,
      inbox: 0,
      revision: 0,
    });
  });

  it('atomically persists branch-scoped ready and skipped node runs', async () => {
    const selectedKey = `${versionA}|selected|b:condition%3Atrue|i:`;
    const skippedKey = `${versionA}|skipped|b:condition%3Afalse|i:`;
    const initial = {
      ...checkpoint({}),
      schemaVersion: 2,
      branchSelections: [],
    } as const;
    const runId = await insertRun({ schedulerState: initial });

    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: {
            ...initial,
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 5,
            admittedInvocationKeys: [selectedKey],
            invocations: [
              {
                invocationKey: selectedKey,
                nodeId: 'selected',
                status: 'running',
                attemptNumber: 1,
                branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
              },
              {
                invocationKey: skippedKey,
                nodeId: 'skipped',
                status: 'skipped',
                attemptNumber: 0,
                branchPath: [{ nodeId: 'condition', outputPort: 'false' }],
              },
            ],
          },
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'run.started',
              occurredAt: '2026-08-24T00:00:00.000Z',
            },
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'node.ready',
              occurredAt: '2026-08-24T00:00:00.000Z',
              invocationKey: selectedKey,
              nodeId: 'selected',
              attemptNumber: 0,
            },
            {
              schemaVersion: 1,
              sequence: 4,
              name: 'node.skipped',
              occurredAt: '2026-08-24T00:00:00.000Z',
              invocationKey: skippedKey,
              nodeId: 'skipped',
              attemptNumber: 0,
            },
          ],
          nodeRunAdmissions: [
            {
              invocationKey: selectedKey,
              nodeId: 'selected',
              sideEffectClass: 'safe',
              branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
            },
            {
              invocationKey: skippedKey,
              nodeId: 'skipped',
              sideEffectClass: 'safe',
              branchPath: [{ nodeId: 'condition', outputPort: 'false' }],
            },
          ],
          attempts: [
            {
              invocationKey: selectedKey,
              nodeId: 'selected',
              attemptNumber: 1,
              sideEffectClass: 'safe',
              branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed' });

    const persisted = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        invocation_key: string;
        branch_context: unknown;
        status: string;
        attempts: number;
        deliveries: number;
      }>(
        `select node.invocation_key,node.branch_context,node.status,
                  count(distinct attempt.id)::int attempts,
                  count(distinct event.id)::int deliveries
             from app.node_runs node
             left join app.node_attempts attempt on attempt.node_run_id=node.id
             left join app.outbox_events event
               on event.aggregate_id=attempt.id
              and event.job_name='execute-node-attempt'
            where node.workspace_id=$1 and node.workflow_run_id=$2
            group by node.id
            order by node.invocation_key`,
        [workspaceA, runId],
      ),
    );
    expect(persisted.rows).toEqual([
      {
        invocation_key: selectedKey,
        branch_context: {
          branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
        },
        status: 'ready',
        attempts: 1,
        deliveries: 1,
      },
      {
        invocation_key: skippedKey,
        branch_context: {
          branchPath: [{ nodeId: 'condition', outputPort: 'false' }],
        },
        status: 'skipped',
        attempts: 0,
        deliveries: 0,
      },
    ]);
    const selectedAttempt = await asRuntime(
      workerBaseUrl,
      workspaceA,
      (client) =>
        client.query<{
          attempt_id: string;
          node_run_id: string;
          outbox_id: string;
          payload_checksum: string;
        }>(
          `select attempt.id attempt_id,node.id node_run_id,
                  event.id outbox_id,event.payload_checksum
             from app.node_runs node
             join app.node_attempts attempt on attempt.node_run_id=node.id
             join app.outbox_events event on event.aggregate_id=attempt.id
            where node.workspace_id=$1 and node.workflow_run_id=$2
              and node.invocation_key=$3
              and event.job_name='execute-node-attempt'`,
          [workspaceA, runId, selectedKey],
        ),
    );
    const selectedDelivery = selectedAttempt.rows[0];
    if (selectedDelivery === undefined)
      throw new Error('branch-scoped fixture attempt missing');
    await expect(
      nodeAttemptStore.claimDelivery({
        workspaceId: workspaceA,
        runId,
        nodeRunId: selectedDelivery.node_run_id,
        attemptId: selectedDelivery.attempt_id,
        delivery: {
          outboxEventId: selectedDelivery.outbox_id,
          payloadChecksum: selectedDelivery.payload_checksum,
        },
        leaseDurationSeconds: 30,
        workerId: 'attempt-worker-branch',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: 'claimed',
      lease: {
        invocationKey: selectedKey,
        branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
      },
    });
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'ready' });
    await asOwner(workspaceA, (client) =>
      client.query(
        `update app.node_runs set branch_context='{}'::jsonb
         where workspace_id=$1 and workflow_run_id=$2 and invocation_key=$3`,
        [workspaceA, runId, skippedKey],
      ),
    );
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });

  it('claims one transport-bound ready attempt with a durable fence', async () => {
    const runId = await insertRun({
      inputRef: {
        schemaVersion: 1,
        kind: 'inline',
        value: { hello: 'world' },
      },
    });
    const invocationKey = `${versionA}|manual|b:|i:`;
    const committed = await store.commitAdvancePlan({
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan: {
        expectedRevision: 0,
        expectedNextEventSequence: 2,
        consumedThroughEventSequence: 1,
        checkpoint: checkpoint({
          revision: 1,
          runStatus: 'running',
          nextEventSequence: 4,
          admittedInvocationKeys: [invocationKey],
          invocations: [
            {
              invocationKey,
              nodeId: 'manual',
              status: 'running',
              attemptNumber: 1,
            },
          ],
        }),
        events: [
          {
            schemaVersion: 1,
            sequence: 2,
            name: 'run.started',
            occurredAt: '2026-08-21T00:00:00.000Z',
          },
          {
            schemaVersion: 1,
            sequence: 3,
            name: 'node.ready',
            occurredAt: '2026-08-21T00:00:00.000Z',
            invocationKey,
            nodeId: 'manual',
            attemptNumber: 0,
          },
        ],
        nodeRunAdmissions: [
          { invocationKey, nodeId: 'manual', sideEffectClass: 'safe' },
        ],
        attempts: [
          {
            invocationKey,
            nodeId: 'manual',
            attemptNumber: 1,
            sideEffectClass: 'safe',
          },
        ],
      },
    });
    if (committed.kind !== 'committed')
      throw new Error('fixture did not commit');
    const admission = committed.admittedAttempts[0];
    if (admission === undefined) throw new Error('fixture attempt missing');
    const outbox = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ id: string; payload_checksum: string }>(
        `select id,payload_checksum from app.outbox_events
         where workspace_id=$1 and aggregate_id=$2
           and job_name='execute-node-attempt'`,
        [workspaceA, admission.attemptId],
      ),
    );
    const delivery = outbox.rows[0];
    if (delivery === undefined) throw new Error('fixture delivery missing');

    const claimed = await nodeAttemptStore.claimDelivery({
      workspaceId: workspaceA,
      runId,
      nodeRunId: admission.nodeRunId,
      attemptId: admission.attemptId,
      delivery: {
        outboxEventId: delivery.id,
        payloadChecksum: delivery.payload_checksum,
      },
      leaseDurationSeconds: 30,
      workerId: 'attempt-worker-1',
      signal: new AbortController().signal,
    });
    expect(claimed).toMatchObject({
      kind: 'claimed',
      lease: {
        attemptId: admission.attemptId,
        attemptNumber: 1,
        fenceToken: 1,
        invocationKey,
        nodeId: 'manual',
        nodeRunId: admission.nodeRunId,
        runId,
        sideEffectClass: 'safe',
        workflowVersionId: versionA,
      },
    });
    if (claimed.kind !== 'claimed') throw new Error('attempt was not claimed');
    expect(claimed.lease.providerDispatchUnresolved).toBeUndefined();
    await expect(
      nodeAttemptStore.claimDelivery({
        workspaceId: workspaceA,
        runId,
        nodeRunId: admission.nodeRunId,
        attemptId: admission.attemptId,
        delivery: {
          outboxEventId: delivery.id,
          payloadChecksum: delivery.payload_checksum,
        },
        leaseDurationSeconds: 30,
        workerId: 'attempt-worker-2',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate' });
    await expect(
      nodeAttemptStore.loadInputs({
        lease: claimed.lease,
        upstreamNodeOutputs: [],
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      abortRequested: false,
      completedNodeOutputs: [],
      runInput: { hello: 'world' },
    });
    const connectionId = randomUUID();
    const secretVersionId = randomUUID();
    const nextSecretVersionId = randomUUID();
    await asOwner(workspaceA, async (client) => {
      await client.query(
        `insert into app.connections (
           id,workspace_id,provider_key,name,auth_type,status,
           current_secret_version_id,created_by
         ) values ($1,$2,'email',$3,'resend_api_key','active',$4,$5)`,
        [
          connectionId,
          workspaceA,
          `Dispatch fence ${connectionId}`,
          secretVersionId,
          actorId,
        ],
      );
      await client.query(
        `insert into app.connection_secret_versions (
           id,workspace_id,connection_id,schema_version,kms_key_reference,
           encrypted_data_key,ciphertext,nonce,auth_tag,created_by
         ) values ($1,$2,$3,1,'kms','a','a',$4,$5,$6)`,
        [
          secretVersionId,
          workspaceA,
          connectionId,
          'a'.repeat(16),
          'a'.repeat(22),
          actorId,
        ],
      );
    });
    const connectionFence = {
      connectionId,
      expectedProviderKey: 'email',
      expectedAuthType: 'resend_api_key',
      secretVersionId,
    } as const;
    const providerDispatchBinding = 'email:v1:sha256:' + 'a'.repeat(64);
    await asAdmin((client) =>
      client.query(`update app.workspaces set status='suspended' where id=$1`, [
        workspaceA,
      ]),
    );
    await expect(
      nodeAttemptStore.markDispatched({
        lease: claimed.lease,
        connectionFence,
        providerDispatchBinding,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptConnectionFenceError);
    await asAdmin((client) =>
      client.query(`update app.workspaces set status='active' where id=$1`, [
        workspaceA,
      ]),
    );
    await expect(
      asAdmin(async (client) => {
        const evidence = await client.query<{
          dispatch_marked_at: Date | null;
          provider_dispatch_binding: string | null;
        }>(
          `select attempt.dispatch_marked_at,node.provider_dispatch_binding
           from app.node_attempts attempt
           join app.node_runs node on node.id=attempt.node_run_id
           where attempt.workspace_id=$1 and attempt.id=$2`,
          [workspaceA, claimed.lease.attemptId],
        );
        return evidence.rows[0];
      }),
    ).resolves.toEqual({
      dispatch_marked_at: null,
      provider_dispatch_binding: null,
    });
    const dispatched = await nodeAttemptStore.markDispatched({
      lease: claimed.lease,
      connectionFence,
      providerDispatchBinding,
      signal: new AbortController().signal,
    });
    expect(dispatched.dispatchedAt).toBeInstanceOf(Date);
    expect(claimed.lease.providerDispatchUnresolved).toBeUndefined();
    await expect(
      nodeAttemptStore.markDispatched({
        lease: claimed.lease,
        connectionFence,
        providerDispatchBinding,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual(dispatched);
    await expect(
      nodeAttemptStore.markDispatched({
        lease: claimed.lease,
        providerDispatchBinding: 'email:v1:sha256:' + 'b'.repeat(64),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptDispatchBindingMismatchError);
    await asOwner(workspaceA, async (client) => {
      await client.query(
        `insert into app.connection_secret_versions (
           id,workspace_id,connection_id,schema_version,kms_key_reference,
           encrypted_data_key,ciphertext,nonce,auth_tag,created_by
         ) values ($1,$2,$3,1,'kms','b','b',$4,$5,$6)`,
        [
          nextSecretVersionId,
          workspaceA,
          connectionId,
          'b'.repeat(16),
          'b'.repeat(22),
          actorId,
        ],
      );
      await client.query(
        `update app.connections set current_secret_version_id=$3
         where workspace_id=$1 and id=$2`,
        [workspaceA, connectionId, nextSecretVersionId],
      );
    });
    await expect(
      nodeAttemptStore.markDispatched({
        lease: claimed.lease,
        connectionFence,
        providerDispatchBinding,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptConnectionFenceError);
    await asOwner(workspaceA, (client) =>
      client.query(
        `update app.connections
         set current_secret_version_id=$3,status='revoked'
         where workspace_id=$1 and id=$2`,
        [workspaceA, connectionId, secretVersionId],
      ),
    );
    await expect(
      nodeAttemptStore.markDispatched({
        lease: claimed.lease,
        connectionFence,
        providerDispatchBinding,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptConnectionFenceError);
    const heartbeat = await nodeAttemptStore.heartbeat({
      lease: claimed.lease,
      leaseDurationSeconds: 30,
      signal: new AbortController().signal,
    });
    expect(heartbeat.abortRequested).toBe(false);
    expect(heartbeat.leaseExpiresAt).toBeInstanceOf(Date);
    const httpArtifactOutput = {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: {
        kind: 'artifact',
        artifactId: randomUUID(),
        byteLength: 70_000,
        mediaType: 'application/octet-stream',
        sha256: 'a'.repeat(64),
      },
      finalOrigin: 'https://provider.example.test',
      redirectCount: 0,
    };
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.artifacts (
           id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
           status,expires_at,finalized_at
         ) values ($1,$2,'node-output',$3,'application/octet-stream',70000,$4,
           'available',now()+interval '1 day',now())`,
        [
          httpArtifactOutput.body.artifactId,
          workspaceA,
          `workspaces/${workspaceA}/artifacts/${httpArtifactOutput.body.artifactId}`,
          httpArtifactOutput.body.sha256,
        ],
      ),
    );
    const completed = await nodeAttemptStore.complete({
      lease: claimed.lease,
      outcome: { status: 'succeeded', output: httpArtifactOutput },
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      signal: new AbortController().signal,
    });
    if (completed.kind !== 'committed')
      throw new Error('attempt completion did not commit');
    expect(completed.outboxEventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const terminal = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        attempt_status: string;
        node_status: string;
        output_matches: boolean;
        terminal_events: number;
        provider_dispatch_binding: string | null;
        continuation_outbox: number;
        completed_receipts: number;
      }>(
        `select
           attempt.status attempt_status,node.status node_status,
           node.provider_dispatch_binding,
           attempt.output_ref=node.output_ref output_matches,
           (select count(*)::int from app.run_events
             where workflow_run_id=$1 and type='node.succeeded') terminal_events,
           (select count(*)::int from app.outbox_events
             where aggregate_id=$1 and job_name='advance-workflow-run'
               and id=$5) continuation_outbox,
           (select count(*)::int from app.inbox_receipts
             where message_id=$4 and completed_at is not null) completed_receipts
         from app.node_attempts attempt
         join app.node_runs node on node.id=attempt.node_run_id
         where attempt.workspace_id=$2 and attempt.id=$3`,
        [
          runId,
          workspaceA,
          admission.attemptId,
          delivery.id,
          completed.outboxEventId,
        ],
      ),
    );
    expect(terminal.rows[0]).toEqual({
      attempt_status: 'succeeded',
      provider_dispatch_binding: providerDispatchBinding,
      node_status: 'succeeded',
      output_matches: true,
      terminal_events: 1,
      continuation_outbox: 1,
      completed_receipts: 1,
    });
    await expect(
      nodeAttemptStore.complete({
        lease: claimed.lease,
        outcome: { status: 'succeeded', output: httpArtifactOutput },
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate', outboxEventId: null });
    await expect(
      nodeAttemptStore.complete({
        lease: claimed.lease,
        outcome: { status: 'succeeded', output: { hello: 'changed' } },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
    await expect(
      nodeAttemptStore.claimDelivery({
        workspaceId: workspaceA,
        runId,
        nodeRunId: admission.nodeRunId,
        attemptId: admission.attemptId,
        delivery: {
          outboxEventId: delivery.id,
          payloadChecksum: delivery.payload_checksum,
        },
        leaseDurationSeconds: 30,
        workerId: 'attempt-worker-1',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate' });
    await expect(
      nodeAttemptStore.claimDelivery({
        workspaceId: workspaceA,
        runId: randomUUID(),
        nodeRunId: admission.nodeRunId,
        attemptId: admission.attemptId,
        delivery: {
          outboxEventId: delivery.id,
          payloadChecksum: delivery.payload_checksum,
        },
        leaseDurationSeconds: 30,
        workerId: 'attempt-worker-1',
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptDeliveryMismatchError);
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ count: number }>(
          `select count(*)::int count
           from app.transport_security_audit_facts
           where workspace_id=$1 and consumer_name='node-attempt-worker'
             and message_id=$2`,
          [workspaceA, delivery.id],
        ),
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });

    const persistedArtifactId = httpArtifactOutput.body.artifactId;
    httpArtifactOutput.body.artifactId = randomUUID();
    const downstreamInvocationKey = `${versionA}|downstream|b:|i:`;
    const downstreamCommitted = await store.commitAdvancePlan({
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan: {
        expectedRevision: 1,
        expectedNextEventSequence: 4,
        consumedThroughEventSequence: 5,
        checkpoint: checkpoint({
          revision: 2,
          runStatus: 'running',
          nextEventSequence: 7,
          admittedInvocationKeys: [invocationKey, downstreamInvocationKey],
          invocations: [
            {
              invocationKey,
              nodeId: 'manual',
              status: 'succeeded',
              attemptNumber: 1,
              output: { kind: 'inline', attemptId: admission.attemptId },
            },
            {
              invocationKey: downstreamInvocationKey,
              nodeId: 'downstream',
              status: 'running',
              attemptNumber: 1,
            },
          ],
        }),
        events: [
          {
            schemaVersion: 1,
            sequence: 6,
            name: 'node.ready',
            occurredAt: '2026-08-21T00:00:01.000Z',
            invocationKey: downstreamInvocationKey,
            nodeId: 'downstream',
            attemptNumber: 0,
          },
        ],
        nodeRunAdmissions: [
          {
            invocationKey: downstreamInvocationKey,
            nodeId: 'downstream',
            sideEffectClass: 'safe',
          },
        ],
        attempts: [
          {
            invocationKey: downstreamInvocationKey,
            nodeId: 'downstream',
            attemptNumber: 1,
            sideEffectClass: 'safe',
          },
        ],
      },
    });
    if (downstreamCommitted.kind !== 'committed')
      throw new Error(
        `downstream fixture did not commit: ${JSON.stringify(downstreamCommitted)}`,
      );
    const downstreamAdmission = downstreamCommitted.admittedAttempts[0];
    if (downstreamAdmission === undefined)
      throw new Error('downstream attempt is missing');
    const downstreamOutbox = await asRuntime(
      workerBaseUrl,
      workspaceA,
      (client) =>
        client.query<{ id: string; payload_checksum: string }>(
          `select id,payload_checksum from app.outbox_events
           where workspace_id=$1 and aggregate_id=$2
             and job_name='execute-node-attempt'`,
          [workspaceA, downstreamAdmission.attemptId],
        ),
    );
    const downstreamDelivery = downstreamOutbox.rows[0];
    if (downstreamDelivery === undefined)
      throw new Error('downstream delivery is missing');
    const downstreamClaim = await nodeAttemptStore.claimDelivery({
      workspaceId: workspaceA,
      runId,
      nodeRunId: downstreamAdmission.nodeRunId,
      attemptId: downstreamAdmission.attemptId,
      delivery: {
        outboxEventId: downstreamDelivery.id,
        payloadChecksum: downstreamDelivery.payload_checksum,
      },
      leaseDurationSeconds: 30,
      workerId: 'attempt-worker-2',
      signal: new AbortController().signal,
    });
    if (downstreamClaim.kind !== 'claimed')
      throw new Error('downstream attempt was not claimed');
    await expect(
      nodeAttemptStore.loadInputs({
        lease: downstreamClaim.lease,
        upstreamNodeOutputs: [{ nodeId: 'manual', invocationKey }],
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      completedNodeOutputs: [
        {
          nodeId: 'manual',
          invocationKey,
          value: {
            status: 200,
            body: {
              kind: 'artifact',
              artifactId: persistedArtifactId,
              byteLength: 70_000,
              mediaType: 'application/octet-stream',
              sha256: 'a'.repeat(64),
            },
          },
        },
      ],
    });
  });

  it('atomically suspends an attempt from database time without an early wakeup', async () => {
    const runId = await insertRun({
      inputRef: { schemaVersion: 1, kind: 'inline', value: { held: true } },
    });
    const invocationKey = `${versionA}|wait|b:|i:`;
    const committed = await store.commitAdvancePlan({
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan: {
        expectedRevision: 0,
        expectedNextEventSequence: 2,
        consumedThroughEventSequence: 1,
        checkpoint: checkpoint({
          revision: 1,
          runStatus: 'running',
          nextEventSequence: 4,
          admittedInvocationKeys: [invocationKey],
          invocations: [
            {
              invocationKey,
              nodeId: 'wait',
              status: 'running',
              attemptNumber: 1,
            },
          ],
        }),
        events: [
          {
            schemaVersion: 1,
            sequence: 2,
            name: 'run.started',
            occurredAt: '2026-08-21T00:00:00.000Z',
          },
          {
            schemaVersion: 1,
            sequence: 3,
            name: 'node.ready',
            occurredAt: '2026-08-21T00:00:00.000Z',
            invocationKey,
            nodeId: 'wait',
            attemptNumber: 0,
          },
        ],
        nodeRunAdmissions: [
          { invocationKey, nodeId: 'wait', sideEffectClass: 'safe' },
        ],
        attempts: [
          {
            admissionKind: 'execute',
            invocationKey,
            nodeId: 'wait',
            attemptNumber: 1,
            sideEffectClass: 'safe',
          },
        ],
      },
    });
    if (committed.kind !== 'committed')
      throw new Error('fixture did not commit');
    const admission = committed.admittedAttempts[0];
    if (admission === undefined) throw new Error('fixture attempt missing');
    const outbox = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ id: string; payload_checksum: string }>(
        `select id,payload_checksum from app.outbox_events
         where workspace_id=$1 and aggregate_id=$2 and job_name='execute-node-attempt'`,
        [workspaceA, admission.attemptId],
      ),
    );
    const delivery = outbox.rows[0];
    if (delivery === undefined) throw new Error('fixture delivery missing');
    const claimed = await nodeAttemptStore.claimDelivery({
      workspaceId: workspaceA,
      runId,
      nodeRunId: admission.nodeRunId,
      attemptId: admission.attemptId,
      delivery: {
        outboxEventId: delivery.id,
        payloadChecksum: delivery.payload_checksum,
      },
      leaseDurationSeconds: 30,
      workerId: 'attempt-worker-wait',
      signal: new AbortController().signal,
    });
    if (claimed.kind !== 'claimed') throw new Error('attempt was not claimed');

    const suspended = await nodeAttemptStore.complete({
      lease: claimed.lease,
      outcome: {
        status: 'suspended',
        output: { held: true },
        durationSeconds: 2,
      },
      signal: new AbortController().signal,
    });
    expect(suspended).toMatchObject({ kind: 'committed' });
    await expect(
      nodeAttemptStore.complete({
        lease: claimed.lease,
        outcome: {
          status: 'suspended',
          output: { held: true },
          durationSeconds: 2,
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate', outboxEventId: null });

    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        attempt_status: string;
        node_status: string;
        resume_at: Date;
        wait_kind: string;
        no_early_resume: boolean;
        waiting_events: number;
        suspension_outboxes: number;
      }>(
        `select attempt.status attempt_status,node.status node_status,node.resume_at,node.wait_kind,
                node.resume_at > clock_timestamp() no_early_resume,
                (select count(*)::int from app.run_events
                  where workflow_run_id=$1 and type='node.waiting') waiting_events,
                (select count(*)::int from app.outbox_events
                  where aggregate_id=$1 and job_name='advance-workflow-run'
                    and id=$3) suspension_outboxes
         from app.node_attempts attempt
         join app.node_runs node on node.id=attempt.node_run_id
         where attempt.id=$2`,
        [runId, admission.attemptId, suspended.outboxEventId],
      ),
    );
    expect(proof.rows[0]).toMatchObject({
      attempt_status: 'succeeded',
      node_status: 'waiting',
      wait_kind: 'node_wait',
      no_early_resume: true,
      waiting_events: 1,
      suspension_outboxes: 1,
    });
    expect(proof.rows[0]?.resume_at).toBeInstanceOf(Date);
    const scanner = createDueNodeWakeupScanner(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 1,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    );
    try {
      await scanner.claimDueWakeups(100);
      const afterScan = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ count: number }>(
          `select count(*)::int count from app.outbox_events
           where aggregate_id=$1 and job_name='advance-workflow-run'`,
          [runId],
        ),
      );
      expect(afterScan.rows[0]?.count).toBe(2);
    } finally {
      await scanner.close();
    }

    const resumeAt = proof.rows[0]?.resume_at.toISOString();
    if (resumeAt === undefined) throw new Error('resume time missing');
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 1,
          expectedNextEventSequence: 4,
          consumedThroughEventSequence: 5,
          checkpoint: checkpoint({
            revision: 2,
            runStatus: 'waiting',
            nextEventSequence: 7,
            admittedInvocationKeys: [invocationKey],
            invocations: [
              {
                invocationKey,
                nodeId: 'wait',
                status: 'waiting',
                attemptNumber: 1,
                resumeAt,
                waitKind: 'node_wait',
                output: { kind: 'inline', attemptId: admission.attemptId },
              },
            ],
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 6,
              name: 'run.waiting',
              occurredAt: '2026-08-21T00:00:01.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 2 });
    await new Promise((resolve) => setTimeout(resolve, 2_050));
    const dueScanner = createDueNodeWakeupScanner(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 1,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    );
    try {
      await dueScanner.claimDueWakeups(100);
    } finally {
      await dueScanner.close();
    }
    const resumed = await store.commitAdvancePlan({
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan: {
        expectedRevision: 2,
        expectedNextEventSequence: 7,
        consumedThroughEventSequence: 6,
        checkpoint: checkpoint({
          revision: 3,
          runStatus: 'running',
          nextEventSequence: 8,
          admittedInvocationKeys: [invocationKey],
          invocations: [
            {
              invocationKey,
              nodeId: 'wait',
              status: 'running',
              attemptNumber: 2,
              output: { kind: 'inline', attemptId: admission.attemptId },
            },
          ],
        }),
        events: [
          {
            schemaVersion: 1,
            sequence: 7,
            name: 'node.ready',
            occurredAt: resumeAt,
            invocationKey,
            nodeId: 'wait',
            attemptNumber: 1,
          },
        ],
        nodeRunAdmissions: [],
        attempts: [
          {
            admissionKind: 'wait_resume',
            invocationKey,
            nodeId: 'wait',
            attemptNumber: 2,
            sideEffectClass: 'safe',
          },
        ],
      },
    });
    if (resumed.kind !== 'committed') throw new Error('resume did not commit');
    const resumeAdmission = resumed.admittedAttempts[0];
    if (resumeAdmission === undefined)
      throw new Error('resume attempt missing');
    const resumeDelivery = await asRuntime(
      workerBaseUrl,
      workspaceA,
      (client) =>
        client.query<{ id: string; payload_checksum: string }>(
          `select id,payload_checksum from app.outbox_events
         where aggregate_id=$1 and job_name='execute-node-attempt'`,
          [resumeAdmission.attemptId],
        ),
    );
    const resumeOutbox = resumeDelivery.rows[0];
    if (resumeOutbox === undefined) throw new Error('resume delivery missing');
    const resumeClaim = await nodeAttemptStore.claimDelivery({
      workspaceId: workspaceA,
      runId,
      nodeRunId: resumeAdmission.nodeRunId,
      attemptId: resumeAdmission.attemptId,
      delivery: {
        outboxEventId: resumeOutbox.id,
        payloadChecksum: resumeOutbox.payload_checksum,
      },
      leaseDurationSeconds: 30,
      workerId: 'attempt-worker-wait-resume',
      signal: new AbortController().signal,
    });
    if (resumeClaim.kind !== 'claimed')
      throw new Error('resume was not claimed');
    expect(resumeClaim.lease.admissionKind).toBe('wait_resume');
    await expect(
      nodeAttemptStore.loadInputs({
        lease: resumeClaim.lease,
        upstreamNodeOutputs: [],
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      abortRequested: false,
      resumeOutput: { held: true },
    });
    await expect(
      nodeAttemptStore.complete({
        lease: resumeClaim.lease,
        outcome: { status: 'succeeded', output: { held: true } },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    const terminal = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        attempts: number;
        node_status: string;
        wait_kind: string | null;
      }>(
        `select node.status node_status,node.wait_kind,count(attempt.id)::int attempts
         from app.node_runs node join app.node_attempts attempt on attempt.node_run_id=node.id
         where node.id=$1 group by node.id`,
        [resumeAdmission.nodeRunId],
      ),
    );
    expect(terminal.rows[0]).toEqual({
      attempts: 2,
      node_status: 'succeeded',
      wait_kind: null,
    });
  });

  it('wakes each due workflow deadline exactly once independently of node timing', async () => {
    const deadlineAt = new Date(Date.now() + 100).toISOString();
    const runId = await insertRun({ deadlineAt, status: 'waiting' });
    const config = parseDatabaseConfig({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    });
    const scannerA = createDeadlineWakeupScanner(config);
    const scannerB = createDeadlineWakeupScanner(config);
    try {
      await scannerA.claimDueWakeups(100);
      const beforeDue = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ deadline_wakeup_at: Date | null; outboxes: number }>(
          `select run.deadline_wakeup_at,
                  (select count(*)::int from app.outbox_events
                    where aggregate_id=run.id and job_name='advance-workflow-run') outboxes
           from app.workflow_runs run where run.id=$1`,
          [runId],
        ),
      );
      expect(beforeDue.rows[0]).toEqual({
        deadline_wakeup_at: null,
        outboxes: 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const claims = await Promise.all([
        scannerA.claimDueWakeups(10),
        scannerB.claimDueWakeups(10),
      ]);
      expect(claims.reduce((sum, claimed) => sum + claimed, 0)).toBe(1);
      await expect(scannerA.claimDueWakeups(10)).resolves.toBe(0);
      const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          deadline_marked: boolean;
          id: string;
          payload: Record<string, unknown>;
          payload_checksum: string;
        }>(
          `select run.deadline_wakeup_at=run.deadline_at deadline_marked,
                  event.id,event.payload,event.payload_checksum
           from app.workflow_runs run
           join app.outbox_events event on event.aggregate_id=run.id
             and event.job_name='advance-workflow-run'
           where run.id=$1`,
          [runId],
        ),
      );
      expect(proof.rows).toHaveLength(1);
      expect(proof.rows[0]).toMatchObject({ deadline_marked: true });
      expect(proof.rows[0]?.payload).toEqual({
        outboxEventId: proof.rows[0]?.id,
        runId,
        schemaVersion: 1,
        workspaceId: workspaceA,
      });
      expect(proof.rows[0]?.payload_checksum).toBe(
        canonicalOutboxPayloadChecksum(proof.rows[0]?.payload),
      );
    } finally {
      await Promise.all([scannerA.close(), scannerB.close()]);
    }
  });

  it('wakes each due node fact exactly once across concurrent global scans', async () => {
    const runId = await insertRun({ status: 'running' });
    const nodeRunId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,retry_due_at
         ) values ($1,$2,$3,'retry-node',$4,'{}','waiting','safe',
                   clock_timestamp() + interval '1 hour')`,
        [nodeRunId, workspaceA, runId, `${versionA}|retry-node|b:|i:`],
      ),
    );
    const scannerA = new Pool({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
    });
    const scannerB = new Pool({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
    });
    try {
      await expect(
        scannerA.query('select app.claim_due_node_run_wakeups(null)'),
      ).rejects.toMatchObject({ code: '22023' });
      await scannerA.query(
        'select app.claim_due_node_run_wakeups(100) claimed',
      );
      const beforeDue = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ count: number }>(
          `select count(*)::int count from app.outbox_events
           where aggregate_id=$1 and job_name='advance-workflow-run'`,
          [runId],
        ),
      );
      expect(beforeDue.rows[0]?.count).toBe(0);
      await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.node_runs set retry_due_at=clock_timestamp()-interval '1 second',
             due_wakeup_at=null where id=$1`,
          [nodeRunId],
        ),
      );

      const scans = await Promise.all([
        scannerA.query<{ claimed: number }>(
          'select app.claim_due_node_run_wakeups(10) claimed',
        ),
        scannerB.query<{ claimed: number }>(
          'select app.claim_due_node_run_wakeups(10) claimed',
        ),
      ]);
      expect(
        scans.reduce((sum, result) => sum + (result.rows[0]?.claimed ?? 0), 0),
      ).toBe(1);
      await expect(
        scannerA.query('select app.claim_due_node_run_wakeups(10) claimed'),
      ).resolves.toMatchObject({ rows: [{ claimed: 0 }] });

      const first = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          id: string;
          payload: Record<string, unknown>;
          payload_checksum: string;
        }>(
          `select id,payload,payload_checksum from app.outbox_events
           where aggregate_id=$1 and job_name='advance-workflow-run'`,
          [runId],
        ),
      );
      expect(first.rows).toHaveLength(1);
      expect(first.rows[0]?.payload).toEqual({
        outboxEventId: first.rows[0]?.id,
        runId,
        schemaVersion: 1,
        workspaceId: workspaceA,
      });
      expect(first.rows[0]?.payload_checksum).toBe(
        canonicalOutboxPayloadChecksum(first.rows[0]?.payload),
      );
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `update app.node_runs
                set due_wakeup_at=retry_due_at + interval '1 second'
              where id=$1`,
            [nodeRunId],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });

      await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.node_runs
              set retry_due_at=clock_timestamp()-interval '2 seconds',
                  due_wakeup_at=null
            where id=$1`,
          [nodeRunId],
        ),
      );
      await expect(
        scannerB.query('select app.claim_due_node_run_wakeups(10) claimed'),
      ).resolves.toMatchObject({ rows: [{ claimed: 1 }] });
      const count = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ count: number }>(
          `select count(*)::int count from app.outbox_events
           where aggregate_id=$1 and job_name='advance-workflow-run'`,
          [runId],
        ),
      );
      expect(count.rows[0]?.count).toBe(2);
    } finally {
      await Promise.all([scannerA.end(), scannerB.end()]);
    }
  });
});
