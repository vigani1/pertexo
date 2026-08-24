import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  acceptWorkflowRun,
  AttemptFenceConflictError,
  AttemptReconciliationRequiredError,
  commitCoordinatorTransition,
  completeNodeAttempt,
  createOutboxDispatcherDatabase,
  createWorkspaceDatabase,
  parseDatabaseConfig,
  readDueNodeRuns,
  readExpiredAttemptReconciliations,
  reconcileExpiredNodeAttempt,
} from '@pertexo/database';
import {
  createQueueProducer,
  JOB_NAME,
  parseQueueJob,
  QUEUE_NAME,
} from '@pertexo/queue';
import * as engine from '@pertexo/workflow-engine/testing';
import type {
  WorkflowCheckpoint,
  WorkflowCheckpointV1,
} from '@pertexo/workflow-engine/testing';
import * as model from '@pertexo/workflow-model';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { performance } from 'node:perf_hooks';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

const integrationEnabled = process.env.PHASE0E_EXECUTION_INTEGRATION === 'true';
const describeIntegration = integrationEnabled ? describe : describe.skip;
const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const processFixturePath = fileURLToPath(
  new URL('./phase0e-process-fixture.mjs', import.meta.url),
);

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@127.0.0.1:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@127.0.0.1:5432/pertexo';
const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@127.0.0.1:5432/pertexo';
const dispatcherUrl =
  process.env.DATABASE_DISPATCHER_URL ??
  'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@127.0.0.1:5432/pertexo';
const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@127.0.0.1:6379/0';

// Phase 0E deliberately keeps authoring out of scope. This graph is immutable
// test fixture data standing in for the version loaded by a future authoring
// slice; production runtime facts are still written through the real APIs.
const WORKFLOW_VERSION_ID = randomUUID();
const WORKSPACE_ID = randomUUID();
const ACTOR_ID = randomUUID();
const ENGINE_VERSION = 'phase0e-v1';
const TRACEPARENT = `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`;
const redisUrl = (() => {
  const parsed = new URL(configuredRedisUrl);
  parsed.pathname = '/15';
  return parsed.toString();
})();
const redisPassword = process.env.REDIS_PASSWORD ?? 'pertexo-local-redis';

type EngineCheckpoint = WorkflowCheckpointV1;

interface MigrationApi {
  migrateDatabase(config: {
    readonly apiRuntimeRole: string;
    readonly connectionString: string;
    readonly dispatcherRole: string;
    readonly ownerRole: string;
    readonly workerRuntimeRole: string;
  }): Promise<void>;
}

type SchedulerState = Parameters<
  typeof commitCoordinatorTransition
>[1]['schedulerState'];

function asSchedulerState(checkpoint: EngineCheckpoint): SchedulerState {
  return checkpoint as unknown as SchedulerState;
}

function asRetainedV1Checkpoint(
  checkpoint: WorkflowCheckpoint,
): EngineCheckpoint {
  if (checkpoint.schemaVersion !== 1)
    throw new Error('Phase 0E retained fixture requires checkpoint V1');
  return checkpoint;
}

const apiDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
);
const workerDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: workerUrl, max: 4 }),
);
const dispatcherDatabase = createOutboxDispatcherDatabase(
  parseDatabaseConfig({ connectionString: dispatcherUrl, max: 2 }),
);

async function migrate(): Promise<void> {
  const moduleUrl = new URL(
    '../../../packages/database/dist/migrations.js',
    import.meta.url,
  ).href;
  const migration = (await import(moduleUrl)) as unknown as MigrationApi;
  await migration.migrateDatabase({
    apiRuntimeRole: 'pertexo_api',
    connectionString: migrationUrl,
    dispatcherRole: 'pertexo_dispatcher',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  });
}

async function resetFixture(): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(`select set_config('app.workspace_id', $1, true)`, [
      WORKSPACE_ID,
    ]);
    await client.query(
      `insert into app.users (id, email, display_name, status)
       values ($1, $2, 'Phase 0E actor', 'active')
       on conflict (id) do nothing`,
      [ACTOR_ID, `phase0e-${ACTOR_ID}@example.test`],
    );
    await client.query(
      `insert into app.workspaces (id, name, slug, status, created_by)
       values ($1, 'Phase 0E recovery', $2, 'active', $3)
       on conflict (id) do update set status = 'active'`,
      [WORKSPACE_ID, `phase0e-${WORKSPACE_ID}`, ACTOR_ID],
    );
    await client.query(`
      truncate table app.node_attempts, app.node_runs,
        app.idempotency_records, app.run_events, app.run_checkpoints,
        app.workflow_runs, app.outbox_events,
        app.phase0e_workflow_versions, app.phase0e_provider_effects cascade
    `);
    await client.query(
      `insert into app.phase0e_workflow_versions (workspace_id, id, graph)
       values ($1, $2, $3::jsonb)`,
      [WORKSPACE_ID, WORKFLOW_VERSION_ID, JSON.stringify(fixtureGraph())],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function prepareProcessFixtures(): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(`
      create table if not exists app.phase0e_workflow_versions (
        workspace_id uuid not null,
        id uuid not null,
        graph jsonb not null,
        created_at timestamptz not null default clock_timestamp(),
        primary key (workspace_id, id)
      );
      create table if not exists app.phase0e_provider_effects (
        workspace_id uuid not null,
        effect_key text not null,
        invocation_count integer not null,
        primary key (workspace_id, effect_key)
      );
      alter table app.phase0e_workflow_versions enable row level security;
      alter table app.phase0e_workflow_versions force row level security;
      alter table app.phase0e_provider_effects enable row level security;
      alter table app.phase0e_provider_effects force row level security;
      drop policy if exists phase0e_workflow_workspace on app.phase0e_workflow_versions;
      create policy phase0e_workflow_workspace on app.phase0e_workflow_versions
        using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
        with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
      drop policy if exists phase0e_effect_workspace on app.phase0e_provider_effects;
      create policy phase0e_effect_workspace on app.phase0e_provider_effects
        using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
        with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
      revoke all on app.phase0e_workflow_versions, app.phase0e_provider_effects from public;
      grant select on app.phase0e_workflow_versions to pertexo_worker;
      grant select, insert, update on app.phase0e_provider_effects to pertexo_worker;
    `);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

interface ProofChild {
  readonly next: (
    predicate?: (value: Record<string, unknown>) => boolean,
  ) => Promise<Record<string, unknown>>;
  readonly kill: () => Promise<void>;
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
}

const activeProofChildren = new Set<ProofChild>();

function spawnProofChild(
  action: string,
  input: Record<string, unknown>,
): ProofChild {
  const child = spawn(process.execPath, [processFixturePath, action], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DATABASE_API_URL: apiUrl,
      DATABASE_WORKER_URL: workerUrl,
      PHASE0E_CHILD_INPUT: JSON.stringify(input),
      PHASE0E_REDIS_URL: redisUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const messages: Record<string, unknown>[] = [];
  const waiters: {
    readonly predicate: (value: Record<string, unknown>) => boolean;
    readonly resolve: (value: Record<string, unknown>) => void;
  }[] = [];
  let stdoutBuffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      const waiterIndex = waiters.findIndex(({ predicate }) =>
        predicate(message),
      );
      if (waiterIndex === -1) messages.push(message);
      else waiters.splice(waiterIndex, 1)[0]?.resolve(message);
    }
  });
  const exited = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
  const proofChild: ProofChild = {
    exited,
    next: async (predicate = () => true) => {
      const existingIndex = messages.findIndex(predicate);
      if (existingIndex !== -1)
        return messages.splice(existingIndex, 1)[0] ?? {};
      return Promise.race([
        new Promise<Record<string, unknown>>((resolve) => {
          waiters.push({ predicate, resolve });
        }),
        exited.then(({ code, signal }) => {
          throw new Error(
            `Phase 0E child exited before evidence: code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
          );
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Phase 0E child evidence timeout: ${stderr}`));
          }, 15_000);
        }),
      ]);
    },
    kill: async () => {
      child.kill('SIGKILL');
      await exited;
    },
  };
  activeProofChildren.add(proofChild);
  void exited.then(() => activeProofChildren.delete(proofChild));
  return proofChild;
}

async function runProofChild(
  action: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const child = spawnProofChild(action, input);
  const message = await child.next();
  const exit = await child.exited;
  if (exit.code !== 0)
    throw new Error(`Phase 0E child failed with ${String(exit.code)}`);
  return message;
}

async function compose(...arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync('docker', ['compose', ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return result.stdout.trim();
}

async function flushRedisProofDatabase(): Promise<void> {
  const response = await compose(
    'exec',
    '-T',
    'redis',
    'redis-cli',
    '--raw',
    '--no-auth-warning',
    '-a',
    redisPassword,
    '-n',
    '15',
    'FLUSHDB',
  );
  if (response !== 'OK') throw new Error('Phase 0E Redis DB15 cleanup failed');
}

async function assertRedisProofHealth(): Promise<void> {
  const response = await compose(
    'exec',
    '-T',
    'redis',
    'redis-cli',
    '--raw',
    '--no-auth-warning',
    '-a',
    redisPassword,
    '-n',
    '15',
    'PING',
  );
  if (response !== 'PONG')
    throw new Error('Phase 0E Redis did not return PONG');
}

async function redisQueueActiveCount(): Promise<number> {
  const response = await compose(
    'exec',
    '-T',
    'redis',
    'redis-cli',
    '--raw',
    '--no-auth-warning',
    '-a',
    redisPassword,
    '-n',
    '15',
    'LLEN',
    `bull:${QUEUE_NAME.nodeAttempts}:active`,
  );
  return Number(response);
}

async function restartRedisService(): Promise<number> {
  const startedAt = performance.now();
  await compose('stop', '--timeout', '10', 'redis');
  await compose('up', '-d', '--wait', 'redis');
  return performance.now() - startedAt;
}

function fixtureGraph(): Record<string, unknown> {
  const node = (id: string) => ({
    id,
    definition: { key: 'test.set', version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: { value: id },
    inputMappings: {},
    connectionRefs: {},
  });
  return {
    schemaVersion: 1,
    nodes: [node('root'), node('branch-a'), node('branch-b'), node('join')],
    edges: [
      {
        id: 'edge-1',
        source: { nodeId: 'root', port: 'out' },
        target: { nodeId: 'branch-a', port: 'in' },
      },
      {
        id: 'edge-2',
        source: { nodeId: 'root', port: 'out' },
        target: { nodeId: 'branch-b', port: 'in' },
      },
      {
        id: 'edge-3',
        source: { nodeId: 'branch-a', port: 'out' },
        target: { nodeId: 'join', port: 'a' },
      },
      {
        id: 'edge-4',
        source: { nodeId: 'branch-b', port: 'out' },
        target: { nodeId: 'join', port: 'b' },
      },
    ],
    settings: {},
  };
}

function schedulerGraph(): engine.SchedulerGraph {
  return {
    deriveReadiness: true,
    nodes: [
      { id: 'root', sideEffectClass: 'safe' },
      { id: 'branch-a', sideEffectClass: 'safe' },
      { id: 'branch-b', sideEffectClass: 'safe' },
      { id: 'join', sideEffectClass: 'safe' },
    ],
    edges: [
      {
        source: { nodeId: 'root', port: 'out' },
        target: { nodeId: 'branch-a', port: 'in' },
      },
      {
        source: { nodeId: 'root', port: 'out' },
        target: { nodeId: 'branch-b', port: 'in' },
      },
      {
        source: { nodeId: 'branch-a', port: 'out' },
        target: { nodeId: 'join', port: 'a' },
      },
      {
        source: { nodeId: 'branch-b', port: 'out' },
        target: { nodeId: 'join', port: 'b' },
      },
    ],
  };
}

function safeInvocationKey(engineKey: string): string {
  return `engine:${createHash('sha256').update(engineKey).digest('hex')}`;
}

async function acceptRun(deadlineAt?: Date): Promise<string> {
  return apiDatabase.withWorkspace(WORKSPACE_ID, async (transaction) => {
    const result = await acceptWorkflowRun(transaction, {
      engineVersion: ENGINE_VERSION,
      initialCheckpoint: engine.createCheckpoint({
        engineVersion: ENGINE_VERSION,
        iterationBudget: 8,
        workflowVersionId: WORKFLOW_VERSION_ID,
      }),
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      operation: 'workflow.run.accept',
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      scope: `phase0e:${randomUUID()}`,
      triggerType: 'manual',
      workflowId: randomUUID(),
      workflowVersionId: WORKFLOW_VERSION_ID,
    });
    return result.runId;
  });
}

async function initializeRunCheckpoint(
  runId: string,
): Promise<EngineCheckpoint> {
  const initial = engine.createCheckpoint({
    engineVersion: ENGINE_VERSION,
    iterationBudget: 8,
    workflowVersionId: WORKFLOW_VERSION_ID,
  });
  await workerDatabase.withWorkspace(WORKSPACE_ID, ({ db }) =>
    db.execute(sql`
      update app.run_checkpoints
      set scheduler_state = ${JSON.stringify(initial)}::jsonb
      where workspace_id = ${WORKSPACE_ID} and workflow_run_id = ${runId}
    `),
  );
  return initial;
}

async function startRun(
  runId: string,
  sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe' = 'safe',
): Promise<{
  readonly attemptId: string;
  readonly checkpoint: EngineCheckpoint;
  readonly engineInvocationKey: string;
  readonly nodeRunId: string;
  readonly providerIdempotencyKey: string | null;
}> {
  const initial = engine.createCheckpoint({
    engineVersion: ENGINE_VERSION,
    iterationBudget: 8,
    workflowVersionId: WORKFLOW_VERSION_ID,
  });
  const plan = engine.advanceWorkflow({
    checkpoint: initial,
    schedulerState: schedulerGraph(),
    occurredAt: new Date().toISOString(),
    maximumAdmissions: 1,
  });
  const plannedAttempt = plan.attempts[0];
  if (plannedAttempt === undefined)
    throw new Error('fixture did not admit root');
  const attemptId = randomUUID();
  const nodeRunId = randomUUID();
  const providerIdempotencyKey =
    sideEffectClass === 'idempotent_with_key'
      ? engine.providerIdempotencyKey({
          invocationKey: plannedAttempt.invocationKey,
          namespace: 'phase0e-provider',
          operationIdentity: 'set-v1',
          runId,
        })
      : null;
  const invocationKey = safeInvocationKey(plannedAttempt.invocationKey);
  const nextCheckpoint = asRetainedV1Checkpoint(plan.checkpoint);
  await workerDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
    commitCoordinatorTransition(transaction, {
      admissions: [
        {
          attemptId,
          attemptNumber: 1,
          branchContext: { branch: 'root' },
          inputRef: { inline: { value: 7 } },
          invocationKey,
          nodeId: plannedAttempt.nodeId,
          nodeRunId,
          providerIdempotencyKey,
          sideEffectClass,
        },
      ],
      engineVersion: ENGINE_VERSION,
      event: { payload: {}, type: 'run.started' },
      expectedRevision: 0,
      nextRunStatus: 'running',
      resumeAt: null,
      runId,
      schedulerState: asSchedulerState(nextCheckpoint),
      traceparent: TRACEPARENT,
    }),
  );
  return {
    attemptId,
    checkpoint: nextCheckpoint,
    engineInvocationKey: plannedAttempt.invocationKey,
    nodeRunId,
    providerIdempotencyKey,
  };
}

async function publishOutbox(duplicateAggregateId?: string): Promise<number> {
  const producer = createQueueProducer({ redisUrl });
  await producer.waitUntilReady(5_000);
  let published = 0;
  try {
    const batch = await dispatcherDatabase.claimBatch({
      enabledJobNames: [
        JOB_NAME.advanceWorkflowRun,
        JOB_NAME.executeNodeAttempt,
      ],
      leaseDurationMillis: 5_000,
      leaseOwner: `phase0e:${randomUUID()}`,
      leaseToken: randomUUID(),
      limit: 100,
      maxAttempts: 5,
    });
    for (const event of batch.events) {
      const job = parseQueueJob({ name: event.jobName, data: event.payload });
      await producer.publish(job);
      if (event.aggregateId === duplicateAggregateId) {
        await producer.publish(job);
      }
      if (await dispatcherDatabase.markPublished(event.id, event.leaseToken)) {
        published += 1;
      }
    }
  } finally {
    await producer.close();
  }
  return published;
}

async function waitFor<T>(
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await operation();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    value = await operation();
  }
  if (!predicate(value)) throw new Error('fixture polling deadline exceeded');
  return value;
}

async function readAttemptState(attemptId: string): Promise<{
  readonly attemptStatus: string;
  readonly leaseExpiresAt: Date | null;
  readonly leaseOwner: string | null;
  readonly nodeResumeAt: Date | null;
  readonly nodeStatus: string;
  readonly runStatus: string;
}> {
  return workerDatabase.withWorkspace(WORKSPACE_ID, ({ db }) =>
    db
      .execute<{
        attempt_status: string;
        lease_expires_at: Date | null;
        lease_owner: string | null;
        node_resume_at: Date | null;
        node_status: string;
        run_status: string;
      }>(
        sql`
      select a.status as attempt_status, a.lease_expires_at, a.lease_owner,
        n.resume_at as node_resume_at, n.status as node_status,
        r.status as run_status
      from app.node_attempts a
      join app.node_runs n on n.workspace_id = a.workspace_id and n.id = a.node_run_id
      join app.workflow_runs r on r.workspace_id = n.workspace_id and r.id = n.workflow_run_id
      where a.workspace_id = ${WORKSPACE_ID} and a.id = ${attemptId}
    `,
      )
      .then((result) => {
        const row = result.rows[0];
        if (row === undefined) throw new Error('attempt fixture row missing');
        return {
          attemptStatus: row.attempt_status,
          leaseExpiresAt:
            row.lease_expires_at === null
              ? null
              : new Date(row.lease_expires_at),
          leaseOwner: row.lease_owner,
          nodeResumeAt:
            row.node_resume_at === null ? null : new Date(row.node_resume_at),
          nodeStatus: row.node_status,
          runStatus: row.run_status,
        };
      }),
  );
}

describeIntegration('Phase 0E real execution recovery fixture', () => {
  beforeAll(async () => {
    await migrate();
    await prepareProcessFixtures();
  });
  beforeEach(async () => {
    await resetFixture();
    await flushRedisProofDatabase();
  });
  afterEach(async () => {
    await Promise.allSettled(
      [...activeProofChildren].map(async (child) => child.kill()),
    );
    await compose('up', '-d', '--wait', 'redis');
    await flushRedisProofDatabase();
    await assertRedisProofHealth();
  });
  afterAll(async () => {
    await Promise.all([
      apiDatabase.close(),
      workerDatabase.close(),
      dispatcherDatabase.close(),
    ]);
  });

  it('kills and reconstructs coordinator processes on both sides of the checkpoint CAS', async () => {
    const graph = fixtureGraph();
    expect(model.validateWorkflowGraph(graph as never)).toMatchObject({
      expandedInvocations: 4,
      ok: true,
    });
    const runId = await acceptRun();
    await initializeRunCheckpoint(runId);
    const recoveryInput = {
      attemptId: randomUUID(),
      engineVersion: ENGINE_VERSION,
      nodeRunId: randomUUID(),
      occurredAt: '2026-08-20T00:00:00.000Z',
      runId,
      traceparent: TRACEPARENT,
      workflowVersionId: WORKFLOW_VERSION_ID,
      workspaceId: WORKSPACE_ID,
    };
    const computedChild = spawnProofChild('compute-hang', recoveryInput);
    const computed = await computedChild.next(
      (message) =>
        message.injectionPoint ===
        'coordinator.compute_complete_before_checkpoint_cas',
    );
    await computedChild.kill();
    expect((await computedChild.exited).signal).toBe('SIGKILL');
    expect(computed.workflowVersionId).toBe(WORKFLOW_VERSION_ID);
    const beforeCommit = await workerDatabase.withWorkspace(
      WORKSPACE_ID,
      ({ db }) =>
        db
          .execute<{ revision: number }>(
            sql`
            select revision from app.run_checkpoints
            where workspace_id = ${WORKSPACE_ID} and workflow_run_id = ${runId}
          `,
          )
          .then((result) => result.rows[0]),
    );
    expect(beforeCommit?.revision).toBe(0);
    const recovered = await runProofChild('commit', recoveryInput);
    expect(recovered.plan).toEqual(computed.plan);
    const persisted = await workerDatabase.withWorkspace(
      WORKSPACE_ID,
      ({ db }) =>
        db
          .execute<{ revision: number; scheduler_state: unknown }>(
            sql`
          select revision, scheduler_state
          from app.run_checkpoints
          where workspace_id = ${WORKSPACE_ID} and workflow_run_id = ${runId}
        `,
          )
          .then((result) => result.rows[0]),
    );
    expect(persisted).toMatchObject({ revision: 1 });
    expect(persisted?.scheduler_state).toEqual(
      expect.objectContaining({ workflowVersionId: WORKFLOW_VERSION_ID }),
    );

    const postCommitRunId = await acceptRun();
    await initializeRunCheckpoint(postCommitRunId);
    const postCommitInput = {
      ...recoveryInput,
      attemptId: randomUUID(),
      nodeRunId: randomUUID(),
      runId: postCommitRunId,
    };
    const committedChild = spawnProofChild('commit-hang', postCommitInput);
    const committed = await committedChild.next(
      (message) =>
        message.injectionPoint ===
        'coordinator.checkpoint_committed_before_queue_ack',
    );
    await committedChild.kill();
    expect((await committedChild.exited).signal).toBe('SIGKILL');
    const redelivery = await runProofChild('commit', {
      ...postCommitInput,
      replayPlan: committed.plan,
    });
    expect(redelivery).toMatchObject({ duplicateFenced: true });
    const facts = await workerDatabase.withWorkspace(WORKSPACE_ID, ({ db }) =>
      db
        .execute<{
          attempt_count: string;
          matching_traceparents: string;
          node_count: string;
          revision: number;
        }>(
          sql`
          select c.revision,
            (select count(*) from app.node_runs n
             where n.workspace_id = ${WORKSPACE_ID} and n.workflow_run_id = ${postCommitRunId}) as node_count,
            (select count(*) from app.node_attempts a join app.node_runs n
               on n.workspace_id = a.workspace_id and n.id = a.node_run_id
             where n.workspace_id = ${WORKSPACE_ID} and n.workflow_run_id = ${postCommitRunId}) as attempt_count,
            (select count(*) from app.outbox_events o
             where o.workspace_id = ${WORKSPACE_ID}
               and o.aggregate_id = ${postCommitInput.attemptId}
               and o.payload ->> 'traceparent' = ${TRACEPARENT}) as matching_traceparents
          from app.run_checkpoints c
          where c.workspace_id = ${WORKSPACE_ID} and c.workflow_run_id = ${postCommitRunId}
        `,
        )
        .then((result) => result.rows[0]),
    );
    expect(facts).toMatchObject({
      attempt_count: '1',
      matching_traceparents: '1',
      node_count: '1',
      revision: 1,
    });
    process.stdout.write(
      `${JSON.stringify({
        event: 'phase0e.process_recovery',
        injectionPoints: [computed.injectionPoint, committed.injectionPoint],
        traceparent: TRACEPARENT,
      })}\n`,
    );
  });

  it('uses real BullMQ delivery, survives a Redis service restart during a durable wait, and resumes without a worker lease', async () => {
    const runId = await acceptRun();
    const started = await startRun(runId);
    const resumeAt = new Date(Date.now() + 3_000);
    const waitingChild = spawnProofChild('consume-wait', {
      resumeAt: resumeAt.toISOString(),
      workerId: 'phase0e-wait-child',
    });
    await waitingChild.next((message) => message.ready === true);
    let redisRestartMs: number | undefined;
    let restartAttempted = false;
    const waitEnteredAt = performance.now();
    try {
      expect(await publishOutbox()).toBeGreaterThan(0);
      const suspended = await waitingChild.next(
        (message) =>
          message.injectionPoint === 'wait.persisted_before_worker_exit',
      );
      expect(suspended.status).toBe('suspended');
      expect(suspended.deliveryTraceparent).toBe(TRACEPARENT);
      expect((await waitingChild.exited).code).toBe(0);
      const waiting = await readAttemptState(started.attemptId);
      expect(waiting).toMatchObject({
        attemptStatus: 'succeeded',
        leaseExpiresAt: null,
        leaseOwner: null,
        nodeStatus: 'waiting',
      });
      expect(waiting.nodeResumeAt?.getTime()).toBe(resumeAt.getTime());
      expect(await redisQueueActiveCount()).toBe(0);
      const earlyDue = await workerDatabase.withWorkspace(
        WORKSPACE_ID,
        (transaction) => readDueNodeRuns(transaction, 10),
      );
      expect(earlyDue).not.toContainEqual(
        expect.objectContaining({ nodeRunId: started.nodeRunId }),
      );

      // The durable wait is now the source of truth and its child worker has
      // exited. Redis is deliberately restarted with no active worker slot.
      restartAttempted = true;
      redisRestartMs = await restartRedisService();
      await flushRedisProofDatabase();
    } finally {
      if (restartAttempted) {
        // A failed restart must never leave the shared dependency down.
        await compose('up', '-d', '--wait', 'redis');
        await flushRedisProofDatabase();
        await assertRedisProofHealth();
      }
    }

    const waiting = await readAttemptState(started.attemptId);
    expect(waiting).toMatchObject({
      attemptStatus: 'succeeded',
      leaseExpiresAt: null,
      leaseOwner: null,
    });
    const restartRecoveredAt = performance.now();
    const due = await waitFor(
      () =>
        workerDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
          readDueNodeRuns(transaction, 10),
        ),
      (rows) => rows.some((row) => row.nodeRunId === started.nodeRunId),
    );
    expect(due[0]?.kind).toBe('wait');

    const nextAttemptId = randomUUID();
    const duplicateResumeInput = {
      attemptId: nextAttemptId,
      engineVersion: ENGINE_VERSION,
      expectedAttemptNumber: 1,
      expectedRevision: 1,
      nodeRunId: started.nodeRunId,
      schedulerState: asSchedulerState(started.checkpoint),
      traceparent: TRACEPARENT,
      workspaceId: WORKSPACE_ID,
    };
    const duplicateResumeResults = await Promise.all([
      runProofChild('resume-due', duplicateResumeInput),
      runProofChild('resume-due', duplicateResumeInput),
    ]);
    expect(
      duplicateResumeResults
        .map(({ duplicateFenced }) => duplicateFenced)
        .sort(),
    ).toEqual([false, true]);
    const resumeFacts = await workerDatabase.withWorkspace(
      WORKSPACE_ID,
      ({ db }) =>
        db
          .execute<{
            attempt_count: string;
            current_attempt_number: number;
            node_ready_event_count: string;
            outbox_count: string;
            revision: number;
          }>(
            sql`
            select c.revision, n.current_attempt_number,
              (select count(*) from app.node_attempts a
               where a.workspace_id = ${WORKSPACE_ID}
                 and a.node_run_id = ${started.nodeRunId}) as attempt_count,
              (select count(*) from app.run_events e
               where e.workspace_id = ${WORKSPACE_ID}
                 and e.workflow_run_id = ${runId}
                 and e.type = 'node.ready'
                 and e.payload ->> 'attemptId' = ${nextAttemptId}) as node_ready_event_count,
              (select count(*) from app.outbox_events o
               where o.workspace_id = ${WORKSPACE_ID}
                 and o.aggregate_id = ${nextAttemptId}) as outbox_count
            from app.run_checkpoints c
            join app.node_runs n
              on n.workspace_id = c.workspace_id
             and n.workflow_run_id = c.workflow_run_id
            where c.workspace_id = ${WORKSPACE_ID}
              and c.workflow_run_id = ${runId}
              and n.id = ${started.nodeRunId}
          `,
          )
          .then((result) => result.rows[0]),
    );
    expect(resumeFacts).toEqual({
      attempt_count: '2',
      current_attempt_number: 2,
      node_ready_event_count: '1',
      outbox_count: '1',
      revision: 2,
    });
    const resumedChild = spawnProofChild('consume-complete-traced', {
      traceparent: TRACEPARENT,
      workerId: 'phase0e-wait-fresh-child',
    });
    await resumedChild.next((message) => message.ready === true);
    await publishOutbox(nextAttemptId);
    const resumed = await resumedChild.next(
      (message) =>
        message.injectionPoint ===
        'wait.fresh_worker_completed_resumed_attempt',
    );
    expect(resumed.status).toBe('completed');
    expect(resumed.deliveryTraceparent).toBe(TRACEPARENT);
    expect(resumed.activeSpan).toMatchObject({
      traceId: '1'.repeat(32),
    });
    expect(resumed.exportedSpan).toMatchObject({
      attributes: {
        'messaging.destination.name': QUEUE_NAME.nodeAttempts,
        'messaging.operation.name': 'process',
        'messaging.operation.type': 'process',
        'pertexo.job.name': 'execute-node-attempt',
      },
      kind: 4,
      parentSpanId: '2'.repeat(16),
      traceId: '1'.repeat(32),
    });
    expect((resumed.activeSpan as { readonly spanId: string }).spanId).toBe(
      (resumed.exportedSpan as { readonly spanId: string }).spanId,
    );
    expect((await resumedChild.exited).code).toBe(0);
    expect((await readAttemptState(nextAttemptId)).attemptStatus).toBe(
      'succeeded',
    );
    process.stdout.write(
      `${JSON.stringify({
        event: 'phase0e.execution.measurements',
        redisRestartMs,
        redisRecoveryToResumeMs: restartRecoveredAt - waitEnteredAt,
        resumeDuplicateFenced: true,
        resumeDuplicateQueuePublished: true,
        traceparent: TRACEPARENT,
        traceSpanActivated: true,
        waitResumeMs: performance.now() - restartRecoveredAt,
      })}\n`,
    );
  });

  it('kills attempt processes before and after dispatch and applies the pinned side-effect truth table', async () => {
    const safeRun = await acceptRun();
    const safe = await startRun(safeRun);
    const safeCrashInput = {
      attemptId: safe.attemptId,
      leaseDurationSeconds: 1,
      markDispatched: false,
      workerId: 'phase0e-safe-crashed',
      workspaceId: WORKSPACE_ID,
    };
    const safeChild = spawnProofChild('claim-hang', safeCrashInput);
    const safeCrash = await safeChild.next(
      (message) =>
        message.injectionPoint ===
        'attempt.claim_complete_before_provider_dispatch',
    );
    await safeChild.kill();
    expect((await safeChild.exited).signal).toBe('SIGKILL');
    const firstLease = safeCrash.lease as { readonly fenceToken: number };
    await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
    const expired = await workerDatabase.withWorkspace(
      WORKSPACE_ID,
      (transaction) => readExpiredAttemptReconciliations(transaction, 10),
    );
    expect(expired).toContainEqual(
      expect.objectContaining({
        attemptId: safe.attemptId,
        sideEffectClass: 'safe',
      }),
    );
    const reclaimed = await workerDatabase.withWorkspace(
      WORKSPACE_ID,
      (transaction) =>
        reconcileExpiredNodeAttempt(transaction, {
          action: 'reclaim',
          attemptId: safe.attemptId,
          expectedFenceToken: firstLease.fenceToken,
          traceparent: TRACEPARENT,
        }),
    );
    await expect(
      workerDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
        completeNodeAttempt(transaction, {
          attemptId: safe.attemptId,
          fenceToken: firstLease.fenceToken,
          status: 'succeeded',
          workerId: 'phase0e-safe-crashed',
        }),
      ),
    ).rejects.toBeInstanceOf(AttemptFenceConflictError);
    expect(reclaimed.fenceToken).toBe(firstLease.fenceToken + 1);
    const safeRecovered = await runProofChild('claim', {
      ...safeCrashInput,
      leaseDurationSeconds: 5,
      workerId: 'phase0e-safe-recovered',
    });
    const safeRecoveredLease = safeRecovered.lease as {
      readonly fenceToken: number;
    };
    await workerDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
      completeNodeAttempt(transaction, {
        attemptId: safe.attemptId,
        fenceToken: safeRecoveredLease.fenceToken,
        outputRef: { inline: { recovered: true } },
        status: 'succeeded',
        traceparent: TRACEPARENT,
        workerId: 'phase0e-safe-recovered',
      }),
    );

    const idempotentRun = await acceptRun();
    const idempotent = await startRun(idempotentRun, 'idempotent_with_key');
    const providerKey = idempotent.providerIdempotencyKey;
    if (providerKey === null) throw new Error('provider key missing');
    const idempotentCrashInput = {
      attemptId: idempotent.attemptId,
      leaseDurationSeconds: 1,
      markDispatched: true,
      providerEffectKey: providerKey,
      workerId: 'phase0e-idempotent-crashed',
      workspaceId: WORKSPACE_ID,
    };
    const idempotentChild = spawnProofChild('claim-hang', idempotentCrashInput);
    const idempotentCrash = await idempotentChild.next(
      (message) =>
        message.injectionPoint ===
        'attempt.provider_dispatch_complete_before_attempt_commit',
    );
    await idempotentChild.kill();
    const idempotentLease = idempotentCrash.lease as {
      readonly fenceToken: number;
    };
    await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
    await workerDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
      reconcileExpiredNodeAttempt(transaction, {
        action: 'reclaim',
        attemptId: idempotent.attemptId,
        expectedFenceToken: idempotentLease.fenceToken,
        traceparent: TRACEPARENT,
      }),
    );
    const idempotentRecovered = await runProofChild('claim', {
      ...idempotentCrashInput,
      leaseDurationSeconds: 5,
      workerId: 'phase0e-idempotent-recovered',
    });
    const idempotentRecoveredLease = idempotentRecovered.lease as {
      readonly fenceToken: number;
    };
    await workerDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
      completeNodeAttempt(transaction, {
        attemptId: idempotent.attemptId,
        fenceToken: idempotentRecoveredLease.fenceToken,
        outputRef: { inline: { providerKey } },
        status: 'succeeded',
        traceparent: TRACEPARENT,
        workerId: 'phase0e-idempotent-recovered',
      }),
    );
    const effects = await workerDatabase.withWorkspace(WORKSPACE_ID, ({ db }) =>
      db
        .execute<{ invocation_count: number }>(
          sql`
            select invocation_count from app.phase0e_provider_effects
            where workspace_id = ${WORKSPACE_ID} and effect_key = ${providerKey}
          `,
        )
        .then((result) => result.rows),
    );
    expect(effects).toEqual([{ invocation_count: 1 }]);

    const unsafeRun = await acceptRun();
    const unsafe = await startRun(unsafeRun, 'unsafe');
    const unsafeChild = spawnProofChild('claim-hang', {
      attemptId: unsafe.attemptId,
      leaseDurationSeconds: 1,
      markDispatched: true,
      workerId: 'phase0e-unsafe-crashed',
      workspaceId: WORKSPACE_ID,
    });
    const unsafeCrash = await unsafeChild.next(
      (message) =>
        message.injectionPoint ===
        'attempt.provider_dispatch_complete_before_attempt_commit',
    );
    await unsafeChild.kill();
    const unsafeLease = unsafeCrash.lease as { readonly fenceToken: number };
    await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
    await expect(
      workerDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
        reconcileExpiredNodeAttempt(transaction, {
          action: 'reclaim',
          attemptId: unsafe.attemptId,
          expectedFenceToken: unsafeLease.fenceToken,
        }),
      ),
    ).rejects.toBeInstanceOf(AttemptReconciliationRequiredError);
    await expect(
      workerDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
        reconcileExpiredNodeAttempt(transaction, {
          action: 'outcome_unknown',
          attemptId: unsafe.attemptId,
          expectedFenceToken: unsafeLease.fenceToken,
          evidenceRef: { reason: 'phase0e-crash-after-dispatch' },
          traceparent: TRACEPARENT,
        }),
      ),
    ).resolves.toMatchObject({ fenceToken: unsafeLease.fenceToken + 1 });
    expect((await readAttemptState(unsafe.attemptId)).attemptStatus).toBe(
      'outcome_unknown',
    );
    process.stdout.write(
      `${JSON.stringify({
        event: 'phase0e.attempt_process_recovery',
        injectionPoints: [
          safeCrash.injectionPoint,
          idempotentCrash.injectionPoint,
          unsafeCrash.injectionPoint,
        ],
        providerEffects: effects.length,
        traceparent: TRACEPARENT,
      })}\n`,
    );
  });

  it('aborts active cooperative work from durable cancellation during Redis loss and preserves completed effects', async () => {
    const runId = await acceptRun();
    const started = await startRun(runId, 'safe');
    const providerEffectKey = `phase0e-completed-effect:${randomUUID()}`;
    const activeChild = spawnProofChild('consume-cancel-cooperative', {
      providerEffectKey,
      workerId: 'phase0e-cancel-active-child',
    });
    await activeChild.next((message) => message.ready === true);
    expect(await publishOutbox()).toBeGreaterThan(0);
    const active = await activeChild.next(
      (message) =>
        message.injectionPoint ===
        'executor.cooperative_work_active_after_completed_effect',
    );
    expect(active).toMatchObject({
      executorSignalAborted: false,
      providerEffectKey,
    });

    let redisStopped = false;
    const outageStartedAt = performance.now();
    try {
      await compose('stop', '--timeout', '10', 'redis');
      redisStopped = true;
      const canceled = await runProofChild('cancel', {
        runId,
        workspaceId: WORKSPACE_ID,
      });
      expect(canceled).toHaveProperty('canceled');
      const terminated = await activeChild.next(
        (message) =>
          message.injectionPoint ===
          'executor.cooperative_cancellation_committed',
      );
      expect(terminated).toMatchObject({
        abortReason: 'durable workflow cancellation observed',
        durableSignalAborted: true,
        executorSignalAborted: true,
        providerEffectKey,
        transportSignalAborted: false,
      });
    } finally {
      await compose('up', '-d', '--wait', 'redis');
      redisStopped = false;
      await assertRedisProofHealth();
    }
    expect(redisStopped).toBe(false);
    expect((await activeChild.exited).code).toBe(0);

    const cancellationFacts = await workerDatabase.withWorkspace(
      WORKSPACE_ID,
      ({ db }) =>
        db
          .execute<{
            attempt_output_ref: unknown;
            attempt_status: string;
            cancellation_durable: boolean;
            effect_count: number;
            node_output_ref: unknown;
            node_status: string;
          }>(
            sql`
            select a.status as attempt_status,
              a.output_ref as attempt_output_ref,
              n.status as node_status,
              n.output_ref as node_output_ref,
              r.cancel_requested_at is not null as cancellation_durable,
              (select invocation_count
               from app.phase0e_provider_effects e
               where e.workspace_id = ${WORKSPACE_ID}
                 and e.effect_key = ${providerEffectKey}) as effect_count
            from app.node_attempts a
            join app.node_runs n
              on n.workspace_id = a.workspace_id and n.id = a.node_run_id
            join app.workflow_runs r
              on r.workspace_id = n.workspace_id
             and r.id = n.workflow_run_id
            where a.workspace_id = ${WORKSPACE_ID}
              and a.id = ${started.attemptId}
          `,
          )
          .then((result) => result.rows[0]),
    );
    expect(cancellationFacts).toMatchObject({
      attempt_output_ref: {
        completedEffectKey: providerEffectKey,
        completedEffectTruthful: true,
      },
      attempt_status: 'canceled',
      cancellation_durable: true,
      effect_count: 1,
      node_output_ref: {
        completedEffectKey: providerEffectKey,
        completedEffectTruthful: true,
      },
      node_status: 'canceled',
    });

    const freshClaim = await runProofChild('claim', {
      attemptId: started.attemptId,
      leaseDurationSeconds: 5,
      markDispatched: false,
      workerId: 'phase0e-cancel-fresh-worker',
      workspaceId: WORKSPACE_ID,
    });
    expect(freshClaim.lease).toBeNull();
    const freshAdmission = await runProofChild('admit-after-cancel', {
      attemptId: randomUUID(),
      engineVersion: ENGINE_VERSION,
      nodeRunId: randomUUID(),
      runId,
      traceparent: TRACEPARENT,
      workflowVersionId: WORKFLOW_VERSION_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(freshAdmission).toMatchObject({
      admissionBlocked: true,
      error: 'execution.cancel_stops_admission',
    });
    process.stdout.write(
      `${JSON.stringify({
        cancellationOutageRecoveryMs: performance.now() - outageStartedAt,
        completedEffectCount: cancellationFacts?.effect_count,
        event: 'phase0e.cooperative_cancellation_recovery',
        providerEffectKey,
      })}\n`,
    );
  });

  it('stops new admission durably on cancellation and reconstructs branch/join/loop state deterministically', async () => {
    const initial = engine.createCheckpoint({
      engineVersion: ENGINE_VERSION,
      iterationBudget: 8,
      workflowVersionId: WORKFLOW_VERSION_ID,
    });
    const branchAndLoopObservations = [
      {
        kind: 'join_declared',
        joinId: 'join-all',
        policy: { kind: 'all' },
        branchIds: ['all-a', 'all-b', 'all-c'],
      },
      {
        kind: 'branch_disposition',
        joinId: 'join-all',
        branch: {
          branchId: 'all-a',
          disposition: 'arrived',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000201',
          },
        },
      },
      {
        kind: 'branch_disposition',
        joinId: 'join-all',
        branch: { branchId: 'all-b', disposition: 'skipped' },
      },
      {
        kind: 'branch_disposition',
        joinId: 'join-all',
        branch: { branchId: 'all-c', disposition: 'missing' },
      },
      {
        kind: 'join_declared',
        joinId: 'join-any',
        policy: { kind: 'any' },
        branchIds: ['a', 'b'],
      },
      {
        kind: 'branch_disposition',
        joinId: 'join-any',
        branch: { branchId: 'a', disposition: 'arrived' },
      },
      {
        kind: 'branch_disposition',
        joinId: 'join-any',
        branch: { branchId: 'b', disposition: 'arrived' },
      },
      {
        kind: 'join_declared',
        joinId: 'join-count',
        policy: { kind: 'count', count: 2 },
        branchIds: ['count-c', 'count-a', 'count-b'],
      },
      {
        kind: 'branch_disposition',
        joinId: 'join-count',
        branch: {
          branchId: 'count-a',
          disposition: 'arrived',
          output: {
            kind: 'artifact',
            artifactId: '00000000-0000-4000-8000-000000000202',
          },
        },
      },
      {
        kind: 'branch_disposition',
        joinId: 'join-count',
        branch: { branchId: 'count-b', disposition: 'missing' },
      },
      {
        kind: 'branch_disposition',
        joinId: 'join-count',
        branch: { branchId: 'count-c', disposition: 'arrived' },
      },
      {
        kind: 'loop_started',
        loopId: 'loop-1',
        collection: {
          kind: 'inline',
          attemptId: '00000000-0000-4000-8000-000000000203',
        },
        collectionChecksum: 'a'.repeat(64),
        collectionSize: 3,
        maxIterations: 3,
        maxConcurrency: 2,
      },
    ] as const;
    const branchLoopSchedulerState = {
      deriveReadiness: false,
      nodes: ['join-all', 'join-any', 'join-count', 'loop-1'].map(
        (id): engine.SchedulerGraph['nodes'][number] => ({
          id,
          sideEffectClass: 'safe',
        }),
      ),
      edges: [],
    } as const;
    const firstAdvance = engine.advanceWorkflow({
      checkpoint: initial,
      schedulerState: branchLoopSchedulerState,
      observations: branchAndLoopObservations,
      occurredAt: '2026-08-20T00:00:00.000Z',
      maximumAdmissions: 10,
    });
    expect(firstAdvance.checkpoint.joins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          joinId: 'join-all',
          selectedBranchIds: ['all-a'],
        }),
        expect.objectContaining({
          joinId: 'join-any',
          selectedBranchIds: ['a'],
        }),
        expect.objectContaining({
          joinId: 'join-count',
          selectedBranchIds: ['count-a', 'count-c'],
        }),
      ]),
    );
    expect(firstAdvance.checkpoint.loops).toContainEqual(
      expect.objectContaining({ activeOrdinals: [0, 1], nextOrdinal: 2 }),
    );
    const secondAdvanceInput = {
      checkpoint: firstAdvance.checkpoint,
      schedulerState: branchLoopSchedulerState,
      observations: [
        {
          kind: 'branch_disposition',
          joinId: 'join-any',
          branch: { branchId: 'b', disposition: 'arrived' },
        },
        { kind: 'loop_iteration_completed', loopId: 'loop-1', ordinal: 0 },
      ],
      occurredAt: '2026-08-20T00:01:00.000Z',
      maximumAdmissions: 0,
    } as const;
    const secondAdvance = engine.advanceWorkflow(secondAdvanceInput);
    const replayedSecondAdvance = engine.advanceWorkflow(secondAdvanceInput);
    expect(replayedSecondAdvance).toEqual(secondAdvance);
    expect(secondAdvance.attempts).toEqual([]);
    expect(secondAdvance.checkpoint.readySet.length).toBeGreaterThan(0);
    expect(secondAdvance.checkpoint.loops).toContainEqual(
      expect.objectContaining({
        activeOrdinals: [1, 2],
        terminalOrdinals: [0],
      }),
    );
    expect(() =>
      engine.advanceWorkflow({
        checkpoint: firstAdvance.checkpoint,
        maximumAdmissions: 10,
        observations: [
          {
            kind: 'branch_disposition',
            joinId: 'join-any',
            branch: { branchId: 'b', disposition: 'missing' },
          },
        ],
        occurredAt: '2026-08-20T00:01:00.000Z',
      }),
    ).toThrow(expect.objectContaining({ code: 'join_invalid' }));
    expect(() =>
      engine.advanceWorkflow({
        checkpoint: initial,
        maximumAdmissions: 10,
        observations: [
          {
            kind: 'loop_started',
            loopId: 'loop-over-limit',
            collection: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000204',
            },
            collectionChecksum: 'b'.repeat(64),
            collectionSize: 4,
            maxConcurrency: 2,
            maxIterations: 3,
          },
        ],
        occurredAt: '2026-08-20T00:00:00.000Z',
      }),
    ).toThrow(expect.objectContaining({ code: 'loop_limit_exceeded' }));

    const cyclicGraph = fixtureGraph();
    (cyclicGraph.edges as Record<string, unknown>[]).push({
      id: 'edge-cycle',
      source: { nodeId: 'join', port: 'out' },
      target: { nodeId: 'root', port: 'in' },
    });
    const cycleValidation = model.validateWorkflowGraph(cyclicGraph as never);
    expect(cycleValidation.ok).toBe(false);
    expect(cycleValidation.issues.some(({ code }) => code === 'cycle')).toBe(
      true,
    );

    const persistenceRunId = await acceptRun();
    await initializeRunCheckpoint(persistenceRunId);
    await workerDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
      commitCoordinatorTransition(transaction, {
        admissions: [],
        engineVersion: ENGINE_VERSION,
        event: { payload: {}, type: 'run.started' },
        expectedRevision: 0,
        nextRunStatus: 'running',
        resumeAt: null,
        runId: persistenceRunId,
        schedulerState: asSchedulerState(
          asRetainedV1Checkpoint(firstAdvance.checkpoint),
        ),
        traceparent: TRACEPARENT,
      }),
    );
    const recoveredTransitionInput = {
      engineVersion: ENGINE_VERSION,
      maximumAdmissions: secondAdvanceInput.maximumAdmissions,
      observations: secondAdvanceInput.observations,
      occurredAt: secondAdvanceInput.occurredAt,
      runId: persistenceRunId,
      schedulerState: branchLoopSchedulerState,
      traceparent: TRACEPARENT,
      workflowVersionId: WORKFLOW_VERSION_ID,
      workspaceId: WORKSPACE_ID,
    };
    const preCheckpointChild = spawnProofChild(
      'engine-recover-compute-hang',
      recoveredTransitionInput,
    );
    const preCheckpoint = await preCheckpointChild.next(
      (message) =>
        message.injectionPoint ===
        'scheduler.recovery_complete_before_recovered_checkpoint_cas',
    );
    expect(preCheckpoint.plan).toEqual(secondAdvance);
    expect(preCheckpoint.workflowVersionId).toBe(WORKFLOW_VERSION_ID);
    expect(preCheckpoint.persistedRevision).toBe(1);
    await preCheckpointChild.kill();
    expect((await preCheckpointChild.exited).signal).toBe('SIGKILL');

    const postCheckpointChild = spawnProofChild(
      'engine-recover-commit-hang',
      recoveredTransitionInput,
    );
    const postCheckpoint = await postCheckpointChild.next(
      (message) =>
        message.injectionPoint ===
        'scheduler.recovered_checkpoint_committed_before_delivery_ack',
    );
    expect(postCheckpoint.plan).toEqual(secondAdvance);
    expect(postCheckpoint.immutableGraphChecksum).toBe(
      preCheckpoint.immutableGraphChecksum,
    );
    expect(postCheckpoint.workflowVersionId).toBe(WORKFLOW_VERSION_ID);
    await postCheckpointChild.kill();
    expect((await postCheckpointChild.exited).signal).toBe('SIGKILL');

    const duplicateRecoveredTransition = await runProofChild(
      'engine-recover-commit',
      {
        ...recoveredTransitionInput,
        replayPlan: postCheckpoint.plan,
      },
    );
    expect(duplicateRecoveredTransition).toMatchObject({
      duplicateFenced: true,
      replayExpectedRevision: 1,
    });
    const recoveredCheckpointFacts = await workerDatabase.withWorkspace(
      WORKSPACE_ID,
      ({ db }) =>
        db
          .execute<{
            event_count: string;
            revision: number;
            scheduler_state: unknown;
          }>(
            sql`
            select c.revision, c.scheduler_state,
              (select count(*) from app.run_events e
               where e.workspace_id = ${WORKSPACE_ID}
                 and e.workflow_run_id = ${persistenceRunId}) as event_count
            from app.run_checkpoints c
            where c.workspace_id = ${WORKSPACE_ID}
              and c.workflow_run_id = ${persistenceRunId}
          `,
          )
          .then((result) => result.rows[0]),
    );
    expect(recoveredCheckpointFacts).toEqual({
      event_count: '2',
      revision: 2,
      scheduler_state: secondAdvance.checkpoint,
    });
    expect(
      (recoveredCheckpointFacts?.scheduler_state as EngineCheckpoint).joins,
    ).toEqual(secondAdvance.checkpoint.joins);
    expect(
      (recoveredCheckpointFacts?.scheduler_state as EngineCheckpoint).loops,
    ).toEqual(secondAdvance.checkpoint.loops);

    const runId = await acceptRun();
    const started = await startRun(runId);
    const canceled = await runProofChild('cancel', {
      runId,
      workspaceId: WORKSPACE_ID,
    });
    expect(canceled).toHaveProperty('canceled');
    let cancelRestartMs: number;
    try {
      cancelRestartMs = await restartRedisService();
      await flushRedisProofDatabase();
      await assertRedisProofHealth();
      const canceledClaim = await runProofChild('claim', {
        attemptId: started.attemptId,
        leaseDurationSeconds: 5,
        markDispatched: false,
        workerId: 'phase0e-canceled-fresh-worker',
        workspaceId: WORKSPACE_ID,
      });
      expect(canceledClaim.lease).toBeNull();
      const canceledAdmission = await runProofChild('admit-after-cancel', {
        attemptId: randomUUID(),
        engineVersion: ENGINE_VERSION,
        nodeRunId: randomUUID(),
        runId,
        traceparent: TRACEPARENT,
        workflowVersionId: WORKFLOW_VERSION_ID,
        workspaceId: WORKSPACE_ID,
      });
      expect(canceledAdmission).toMatchObject({
        admissionBlocked: true,
        error: 'execution.cancel_stops_admission',
      });
    } finally {
      await compose('up', '-d', '--wait', 'redis');
      await flushRedisProofDatabase();
      await assertRedisProofHealth();
    }
    process.stdout.write(
      `${JSON.stringify({
        cancellationRedisRestartMs: cancelRestartMs,
        event: 'phase0e.scheduler_process_recovery',
        exactLoopConcurrency: 2,
        exactLoopIterations: 3,
        postCheckpointCrashSignal: 'SIGKILL',
        preCheckpointCrashSignal: 'SIGKILL',
        policies: ['all', 'any', 'count'],
        persistedRevision: recoveredCheckpointFacts?.revision,
      })}\n`,
    );
  });
});
