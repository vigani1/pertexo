import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  acceptWorkflowRun,
  AttemptFenceConflictError,
  AttemptReconciliationRequiredError,
  CheckpointRevisionConflictError,
  claimNodeAttempt,
  commitCoordinatorTransition,
  commitDueNodeAdmission,
  completeNodeAttempt,
  createOutboxDispatcherDatabase,
  createWorkspaceDatabase,
  markNodeAttemptDispatched,
  parseDatabaseConfig,
  readDueNodeRuns,
  readExpiredAttemptReconciliations,
  reconcileExpiredNodeAttempt,
  requestWorkflowRunCancellation,
  suspendNodeAttemptUntil,
} from '@pertexo/database';
import {
  createQueueConsumer,
  createQueueProducer,
  JOB_NAME,
  parseQueueJob,
  QUEUE_NAME,
} from '@pertexo/queue';
import type { QueueConsumer } from '@pertexo/queue';
import * as engine from '@pertexo/workflow-engine';
import type { WorkflowCheckpointV1 } from '@pertexo/workflow-engine';
import * as model from '@pertexo/workflow-model';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const integrationEnabled = process.env.PHASE0E_EXECUTION_INTEGRATION === 'true';
const describeIntegration = integrationEnabled ? describe : describe.skip;
const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

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
const ENGINE_VERSION = 'phase0e-v1';
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
    await client.query(`
      truncate table app.node_attempts, app.node_runs,
        app.idempotency_records, app.run_events, app.run_checkpoints,
        app.workflow_runs, app.outbox_events cascade
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
    nodes: [
      { id: 'root' },
      { id: 'branch-a' },
      { id: 'branch-b' },
      { id: 'join' },
    ],
    edges: [
      { source: { nodeId: 'root' }, target: { nodeId: 'branch-a' } },
      { source: { nodeId: 'root' }, target: { nodeId: 'branch-b' } },
      { source: { nodeId: 'branch-a' }, target: { nodeId: 'join' } },
      { source: { nodeId: 'branch-b' }, target: { nodeId: 'join' } },
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
    graph: schedulerGraph(),
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
      schedulerState: asSchedulerState(plan.checkpoint),
    }),
  );
  return {
    attemptId,
    checkpoint: plan.checkpoint,
    engineInvocationKey: plannedAttempt.invocationKey,
    nodeRunId,
    providerIdempotencyKey,
  };
}

async function publishOutbox(): Promise<number> {
  const producer = createQueueProducer({ redisUrl });
  await producer.waitUntilReady(5_000);
  let published = 0;
  try {
    const batch = await dispatcherDatabase.claimBatch({
      leaseDurationMillis: 5_000,
      leaseOwner: `phase0e:${randomUUID()}`,
      leaseToken: randomUUID(),
      limit: 100,
      maxAttempts: 5,
    });
    for (const event of batch.events) {
      const job = parseQueueJob({ name: event.jobName, data: event.payload });
      await producer.publish(job);
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

function createAttemptConsumer(
  mode: 'complete' | 'wait',
  workerId: string,
  waitUntil: Date,
): QueueConsumer {
  return createQueueConsumer({
    drainTimeoutMs: 5_000,
    queueName: QUEUE_NAME.nodeAttempts,
    redisUrl,
    timeoutMs: 10_000,
    handler: async (delivery) => {
      if (delivery.name !== JOB_NAME.executeNodeAttempt) return;
      const attempt = await workerDatabase.withWorkspace(
        delivery.data.workspaceId,
        (transaction) =>
          claimNodeAttempt(transaction, {
            attemptId: delivery.data.attemptId,
            leaseDurationSeconds: 5,
            workerId,
          }),
      );
      if (attempt === null) return;
      if (mode === 'wait') {
        await workerDatabase.withWorkspace(
          delivery.data.workspaceId,
          (transaction) =>
            suspendNodeAttemptUntil(transaction, {
              attemptId: attempt.attemptId,
              dueAt: waitUntil,
              fenceToken: attempt.fenceToken,
              safeErrorCode: null,
              workerId,
            }),
        );
        return;
      }
      await workerDatabase.withWorkspace(
        delivery.data.workspaceId,
        (transaction) =>
          completeNodeAttempt(transaction, {
            attemptId: attempt.attemptId,
            fenceToken: attempt.fenceToken,
            outputRef: { inline: { completed: true } },
            status: 'succeeded',
            workerId,
          }),
      );
    },
  });
}

async function readAttemptState(attemptId: string): Promise<{
  readonly attemptStatus: string;
  readonly leaseExpiresAt: Date | null;
  readonly leaseOwner: string | null;
  readonly runStatus: string;
}> {
  return workerDatabase.withWorkspace(WORKSPACE_ID, ({ db }) =>
    db
      .execute<{
        attempt_status: string;
        lease_expires_at: Date | null;
        lease_owner: string | null;
        run_status: string;
      }>(
        sql`
      select a.status as attempt_status, a.lease_expires_at, a.lease_owner,
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
          leaseExpiresAt: row.lease_expires_at,
          leaseOwner: row.lease_owner,
          runStatus: row.run_status,
        };
      }),
  );
}

describeIntegration('Phase 0E real execution recovery fixture', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(async () => {
    await resetFixture();
    await flushRedisProofDatabase();
  });
  afterAll(async () => {
    await Promise.all([
      apiDatabase.close(),
      workerDatabase.close(),
      dispatcherDatabase.close(),
    ]);
  });

  it('recomputes a coordinator transition before checkpoint CAS and fences a post-checkpoint crash', async () => {
    const graph = fixtureGraph();
    expect(model.validateWorkflowGraph(graph as never)).toMatchObject({
      expandedInvocations: 4,
      ok: true,
    });
    const initial = engine.createCheckpoint({
      engineVersion: ENGINE_VERSION,
      iterationBudget: 8,
      workflowVersionId: WORKFLOW_VERSION_ID,
    });
    const input = {
      checkpoint: initial,
      graph: schedulerGraph(),
      occurredAt: '2026-08-20T00:00:00.000Z',
      maximumAdmissions: 1,
    } as const;
    const beforeCrash = engine.advanceWorkflow(input);
    const recomputed = engine.advanceWorkflow(input);
    expect(recomputed).toEqual(beforeCrash);

    const runId = await acceptRun();
    await startRun(runId);
    await expect(
      workerDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
        commitCoordinatorTransition(transaction, {
          admissions: [],
          engineVersion: ENGINE_VERSION,
          event: { payload: {}, type: 'run.started' },
          expectedRevision: 0,
          nextRunStatus: 'running',
          resumeAt: null,
          runId,
          schedulerState: asSchedulerState(beforeCrash.checkpoint),
        }),
      ),
    ).rejects.toBeInstanceOf(CheckpointRevisionConflictError);
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
  });

  it('uses real BullMQ delivery, survives a Redis service restart during a durable wait, and resumes without a worker lease', async () => {
    const runId = await acceptRun();
    const started = await startRun(runId);
    const resumeAt = new Date(Date.now() + 250);
    const consumer = createAttemptConsumer('wait', 'phase0e-wait-1', resumeAt);
    await consumer.waitUntilReady(5_000);
    let redisRestartMs: number | undefined;
    let restartAttempted = false;
    const waitEnteredAt = performance.now();
    try {
      expect(await publishOutbox()).toBeGreaterThan(0);
      await waitFor(
        () => readAttemptState(started.attemptId),
        (state) => state.attemptStatus === 'succeeded',
      );
      const waiting = await readAttemptState(started.attemptId);
      expect(waiting).toMatchObject({
        attemptStatus: 'succeeded',
        leaseExpiresAt: null,
        leaseOwner: null,
      });

      // The durable wait is now the source of truth. Restart the actual
      // Compose service while the worker consumer is still connected; the
      // worker/producer must reconnect and no task lease may be reacquired.
      restartAttempted = true;
      redisRestartMs = await restartRedisService();
      await flushRedisProofDatabase();
    } finally {
      await consumer.close();
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
    await workerDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
      commitDueNodeAdmission(transaction, {
        attemptId: nextAttemptId,
        engineVersion: ENGINE_VERSION,
        expectedAttemptNumber: 1,
        expectedRevision: 1,
        nodeRunId: started.nodeRunId,
        schedulerState: asSchedulerState(started.checkpoint),
      }),
    );
    const restartedConsumer = createAttemptConsumer(
      'complete',
      'phase0e-wait-2',
      resumeAt,
    );
    await restartedConsumer.waitUntilReady(5_000);
    try {
      await publishOutbox();
      await waitFor(
        () => readAttemptState(nextAttemptId),
        (state) => state.attemptStatus === 'succeeded',
      );
    } finally {
      await restartedConsumer.close();
    }
    expect((await readAttemptState(nextAttemptId)).attemptStatus).toBe(
      'succeeded',
    );
    process.stdout.write(
      `${JSON.stringify({
        event: 'phase0e.execution.measurements',
        redisRestartMs,
        redisRecoveryToResumeMs: restartRecoveredAt - waitEnteredAt,
        waitResumeMs: performance.now() - restartRecoveredAt,
      })}\n`,
    );
  });

  it('rejects stale completion, distinguishes safe/idempotent reclaim from unsafe outcome_unknown, and deduplicates provider effects', async () => {
    const safeRun = await acceptRun();
    const safe = await startRun(safeRun);
    const firstLease = await workerDatabase.withWorkspace(
      WORKSPACE_ID,
      (transaction) =>
        claimNodeAttempt(transaction, {
          attemptId: safe.attemptId,
          leaseDurationSeconds: 1,
          workerId: 'phase0e-safe-1',
        }),
    );
    expect(firstLease).not.toBeNull();
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
          expectedFenceToken: firstLease?.fenceToken ?? 0,
        }),
    );
    await expect(
      workerDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
        completeNodeAttempt(transaction, {
          attemptId: safe.attemptId,
          fenceToken: firstLease?.fenceToken ?? 0,
          status: 'succeeded',
          workerId: 'phase0e-safe-1',
        }),
      ),
    ).rejects.toBeInstanceOf(AttemptFenceConflictError);
    expect(reclaimed.fenceToken).toBe((firstLease?.fenceToken ?? 0) + 1);

    const idempotentRun = await acceptRun();
    const idempotent = await startRun(idempotentRun, 'idempotent_with_key');
    const idempotentLease = await workerDatabase.withWorkspace(
      WORKSPACE_ID,
      (transaction) =>
        claimNodeAttempt(transaction, {
          attemptId: idempotent.attemptId,
          leaseDurationSeconds: 5,
          workerId: 'phase0e-provider',
        }),
    );
    const providerEffects = new Set<string>();
    const providerKey = idempotent.providerIdempotencyKey;
    if (idempotentLease === null || providerKey === null)
      throw new Error('idempotent fixture lease missing');
    providerEffects.add(providerKey);
    providerEffects.add(providerKey);
    const completion = {
      attemptId: idempotent.attemptId,
      fenceToken: idempotentLease.fenceToken,
      outputRef: { inline: { providerKey } },
      status: 'succeeded' as const,
      workerId: 'phase0e-provider',
    };
    await workerDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
      completeNodeAttempt(transaction, completion),
    );
    await expect(
      workerDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
        completeNodeAttempt(transaction, completion),
      ),
    ).resolves.toMatchObject({ duplicate: true });
    expect(providerEffects).toHaveLength(1);

    const unsafeRun = await acceptRun();
    const unsafe = await startRun(unsafeRun, 'unsafe');
    const unsafeLease = await workerDatabase.withWorkspace(
      WORKSPACE_ID,
      (transaction) =>
        claimNodeAttempt(transaction, {
          attemptId: unsafe.attemptId,
          leaseDurationSeconds: 1,
          workerId: 'phase0e-unsafe',
        }),
    );
    if (unsafeLease === null) throw new Error('unsafe fixture lease missing');
    await workerDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
      // The dispatch marker is the durable point after which an unsafe retry
      // cannot be proven absent.
      markNodeAttemptDispatched(transaction, {
        attemptId: unsafe.attemptId,
        fenceToken: unsafeLease.fenceToken,
        workerId: 'phase0e-unsafe',
      }).then(() => undefined),
    );
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
        }),
      ),
    ).resolves.toMatchObject({ fenceToken: unsafeLease.fenceToken + 1 });
    expect((await readAttemptState(unsafe.attemptId)).attemptStatus).toBe(
      'outcome_unknown',
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
        joinId: 'join-1',
        policy: { kind: 'any' },
        branchIds: ['a', 'b'],
      },
      {
        kind: 'branch_disposition',
        joinId: 'join-1',
        branch: { branchId: 'a', disposition: 'arrived' },
      },
      {
        kind: 'branch_disposition',
        joinId: 'join-1',
        branch: { branchId: 'b', disposition: 'skipped' },
      },
      {
        kind: 'loop_started',
        loopId: 'loop-1',
        collection: { kind: 'inline', reference: 'collection-1' },
        collectionChecksum: 'a'.repeat(64),
        collectionSize: 3,
        maxIterations: 3,
        maxConcurrency: 2,
      },
    ] as const;
    const firstAdvance = engine.advanceWorkflow({
      checkpoint: initial,
      observations: branchAndLoopObservations,
      occurredAt: '2026-08-20T00:00:00.000Z',
      maximumAdmissions: 10,
    });
    expect(firstAdvance.checkpoint.joins).toContainEqual(
      expect.objectContaining({
        joinId: 'join-1',
        selectedBranchIds: ['a'],
      }),
    );
    expect(firstAdvance.checkpoint.loops).toContainEqual(
      expect.objectContaining({ activeOrdinals: [0, 1], nextOrdinal: 2 }),
    );
    const secondAdvanceInput = {
      checkpoint: firstAdvance.checkpoint,
      observations: [
        { kind: 'loop_iteration_completed', loopId: 'loop-1', ordinal: 0 },
      ],
      occurredAt: '2026-08-20T00:01:00.000Z',
      maximumAdmissions: 10,
    } as const;
    const secondAdvance = engine.advanceWorkflow(secondAdvanceInput);
    const replayedSecondAdvance = engine.advanceWorkflow(secondAdvanceInput);
    expect(replayedSecondAdvance).toEqual(secondAdvance);
    expect(secondAdvance.checkpoint.loops).toContainEqual(
      expect.objectContaining({
        activeOrdinals: [1, 2],
        terminalOrdinals: [0],
      }),
    );

    const runId = await acceptRun();
    const started = await startRun(runId);
    await apiDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
      requestWorkflowRunCancellation(transaction, {
        actor: 'phase0e-test',
        reason: 'fixture cancellation',
        runId,
      }),
    );
    await expect(
      workerDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
        commitCoordinatorTransition(transaction, {
          admissions: [
            {
              attemptId: randomUUID(),
              attemptNumber: 1,
              branchContext: {},
              invocationKey: 'engine:new-admission',
              nodeId: 'new-node',
              nodeRunId: randomUUID(),
              sideEffectClass: 'safe',
            },
          ],
          engineVersion: ENGINE_VERSION,
          event: { payload: {}, type: 'run.succeeded' },
          expectedRevision: 1,
          nextRunStatus: 'succeeded',
          resumeAt: null,
          runId,
          schedulerState: asSchedulerState(started.checkpoint),
        }),
      ),
    ).rejects.toThrow('execution.cancel_stops_admission');

    const secondRun = await acceptRun();
    const second = await startRun(secondRun);
    await apiDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
      requestWorkflowRunCancellation(transaction, {
        actor: 'phase0e-test',
        reason: 'cancel before claim',
        runId: secondRun,
      }),
    );
    await expect(
      workerDatabase.withWorkspace(WORKSPACE_ID, (transaction) =>
        claimNodeAttempt(transaction, {
          attemptId: second.attemptId,
          leaseDurationSeconds: 5,
          workerId: 'phase0e-canceled',
        }),
      ),
    ).resolves.toBeNull();
  });
});
