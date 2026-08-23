import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  canonicalOutboxPayloadChecksum,
  CoordinatorPlanInvalidError,
  CoordinatorRunStateCorruptError,
  checkDatabaseReadiness,
  createCoordinatorRunStore,
  createNodeAttemptRunStore,
  NodeAttemptDeliveryMismatchError,
  NodeAttemptStateCorruptError,
  parseDatabaseConfig,
} from '../src/index.js';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';

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
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
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
    await client.query('alter table app.workflows force row level security');
    await client.query(
      'alter table app.workflow_versions force row level security',
    );
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
}): Promise<string> {
  const workspaceId = input.workspaceId ?? workspaceA;
  const runId = randomUUID();
  const workflowVersionId = input.workflowVersionId ?? versionA;
  await asRuntime(apiBaseUrl, workspaceId, async (client) => {
    await client.query(
      `insert into app.workflow_runs (
         id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
         deadline_at,input_ref
       ) values ($1,$2,$3,$4,'manual',$5,$6,$7::jsonb)`,
      [
        runId,
        workspaceId,
        input.workflowId ?? workflowA,
        workflowVersionId,
        input.status ?? 'queued',
        input.deadlineAt ?? null,
        input.inputRef === undefined ? null : JSON.stringify(input.inputRef),
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
          migrationHead: '0030_coordinator_retry_decisions.sql',
          role: 'pertexo_worker',
        });
      } finally {
        await readinessPool.end();
      }
    } finally {
      await admin.query(
        `drop database if exists "${zeroDatabaseName}" with (force)`,
      );
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
        migrationHead: '0030_coordinator_retry_decisions.sql',
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
        migrationHead: '0030_coordinator_retry_decisions.sql',
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
      migrationHead: '0030_coordinator_retry_decisions.sql',
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
            value: { ok: true },
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
            value: { ok: true },
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
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
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
          },
        ],
      }),
      status: 'waiting',
    });
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,current_attempt_id,current_attempt_number,resume_at
         ) values ($1,$2,$3,'waiting',$4,'{}','waiting','safe',$5,1,$6)`,
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
    await seedSucceededFact(artifactRun, artifactInvocation, {
      schemaVersion: 1,
      kind: 'artifact',
      artifactId,
    });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: artifactRun,
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
                invocationKey: artifactInvocation,
                nodeId: 'artifact',
                status: 'succeeded',
                attemptNumber: 1,
                output: { kind: 'artifact', artifactId },
              },
            ],
          }),
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
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
             status,side_effect_class,current_attempt_id,current_attempt_number,retry_due_at
           ) values ($1,$2,$3,$4,$5,'{}','waiting','safe',$6,1,$7)`,
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
        upstreamNodeIds: [],
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      abortRequested: false,
      completedNodeOutputs: {},
      runInput: { hello: 'world' },
    });
    const dispatched = await nodeAttemptStore.markDispatched({
      lease: claimed.lease,
      signal: new AbortController().signal,
    });
    expect(dispatched.dispatchedAt).toBeInstanceOf(Date);
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
        continuation_outbox: number;
        completed_receipts: number;
      }>(
        `select
           attempt.status attempt_status,node.status node_status,
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
        upstreamNodeIds: ['manual'],
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      completedNodeOutputs: {
        manual: {
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
    });
  });
});
