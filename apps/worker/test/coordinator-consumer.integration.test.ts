import { createHash, randomUUID } from 'node:crypto';

import {
  acceptWorkflowRun,
  createWorkspaceDatabase,
  parseDatabaseConfig,
} from '@pertexo/database';
import { CORE_REGISTRY_RELEASE } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpoint,
} from '@pertexo/workflow-engine';
import { createQueueProducer, JOB_NAME, QUEUE_NAME } from '@pertexo/queue';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCoordinatorRuntime } from '../src/execution/coordinator-runtime.js';
import { createNodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';

const enabled = process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
const describeIntegration = enabled ? describe : describe.skip;
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';
const redisUrl = (() => {
  const parsed = new URL(configuredRedisUrl);
  parsed.pathname = '/12';
  return parsed.toString();
})();

const actorId = randomUUID();
const workspaceId = randomUUID();
const workflowId = randomUUID();
const workflowVersionId = randomUUID();
const engineVersion = 'phase3-engine-v1';
const ownerPool = new Pool({ connectionString: migrationUrl, max: 1 });
const workerPool = new Pool({ connectionString: workerUrl, max: 2 });
const apiDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
);

function redisConnection(): {
  db: number;
  host: string;
  password?: string;
  port: number;
} {
  const parsed = new URL(redisUrl);
  return {
    db: 12,
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password === ''
      ? {}
      : { password: decodeURIComponent(parsed.password) }),
  };
}

function graph() {
  return {
    schemaVersion: 1 as const,
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      {
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'set',
        definition: { key: 'core.set', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {
          literal: { kind: 'literal' as const, value: 1 },
          fromRun: { kind: 'run_input' as const, path: '$.hello' },
          fromNode: {
            kind: 'node_output' as const,
            nodeId: 'manual',
            path: '$.hello',
          },
          expression: {
            kind: 'expression' as const,
            language: 'jsonata' as const,
            expression: 'runInput.hello',
            policyVersion: 1,
          },
        },
        connectionRefs: {},
      },
      {
        id: 'terminate',
        definition: { key: 'core.terminate', version: 1 },
        position: { x: 20, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {
          result: { kind: 'node_output' as const, nodeId: 'set', path: '$' },
        },
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'manual-set',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'set', port: 'in' },
      },
      {
        id: 'set-terminate',
        source: { nodeId: 'set', port: 'out' },
        target: { nodeId: 'terminate', port: 'in' },
      },
    ],
  };
}

async function ownerQuery<T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<readonly T[]> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await client.query<T>(statement, [...parameters]);
    await client.query('commit');
    return result.rows;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function workerQuery<T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<readonly T[]> {
  const client = await workerPool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await client.query<T>(statement, [...parameters]);
    await client.query('commit');
    return result.rows;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function waitFor<T>(
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await operation();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    value = await operation();
  }
  if (!predicate(value)) {
    throw new Error(
      `coordinator proof timed out with ${JSON.stringify(value)}`,
    );
  }
  return value;
}

async function setupFixture(): Promise<void> {
  const release = composeExecutableCompatibilityRelease(CORE_REGISTRY_RELEASE);
  const executable = buildWorkflowExecutableV2({ graph: graph(), release });
  await ownerQuery(
    `insert into app.users (id, email, display_name, status)
       values ($1, $2, 'Coordinator proof', 'active')`,
    [actorId, `coordinator-${actorId}@example.test`],
  );
  await ownerQuery(
    `insert into app.workspaces (id, name, slug, status, created_by)
       values ($1, 'Coordinator proof', $2, 'active', $3)`,
    [workspaceId, `coordinator-${workspaceId}`, actorId],
  );
  await ownerQuery(
    `insert into app.workflows (id, workspace_id, name, created_by)
       values ($1, $2, 'Coordinator proof', $3)`,
    [workflowId, workspaceId, actorId],
  );
  await ownerQuery(
    `insert into app.workflow_versions (
       id, workspace_id, workflow_id, version_number, schema_version,
       graph_json, checksum, executable_schema_version, executable_json,
       compatibility_release_epoch, published_by
     ) values ($1, $2, $3, 1, 1, $4::jsonb, $5, 2, $6::jsonb, $7, $8)`,
    [
      workflowVersionId,
      workspaceId,
      workflowId,
      JSON.stringify(graph()),
      executable.checksum,
      JSON.stringify(executable.envelope),
      release.epoch,
      actorId,
    ],
  );
  const queue = new Queue(QUEUE_NAME.workflowCoordinator, {
    connection: redisConnection(),
  });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
  }
  const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
    connection: redisConnection(),
  });
  try {
    await attemptQueue.obliterate({ force: true });
  } finally {
    await attemptQueue.close();
  }
}

async function cleanupFixture(): Promise<void> {
  const queue = new Queue(QUEUE_NAME.workflowCoordinator, {
    connection: redisConnection(),
  });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
    const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
      connection: redisConnection(),
    });
    try {
      await attemptQueue.obliterate({ force: true });
    } finally {
      await attemptQueue.close();
    }
    await apiDatabase.close();
    await ownerPool.end();
    await workerPool.end();
  }
}

async function acceptRun(): Promise<
  Readonly<{ outboxEventId: string; runId: string }>
> {
  const initialCheckpoint = createCheckpoint({
    engineVersion,
    workflowVersionId,
    iterationBudget: 0,
    nextEventSequence: 2,
  });
  return apiDatabase.withWorkspace(workspaceId, (transaction) =>
    acceptWorkflowRun(transaction, {
      engineVersion,
      initialCheckpoint,
      keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      operation: 'workflow.run.accept',
      runInput: { hello: 'world' },
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      scope: `coordinator:${workflowId}`,
      triggerType: 'manual',
      workflowId,
      workflowVersionId,
    }),
  );
}

async function waitForAttemptOutbox(
  runId: string,
  excludedIds: readonly string[] = [],
): Promise<{
  attemptId: string;
  nodeRunId: string;
  outboxEventId: string;
}> {
  const rows = await waitFor(
    () =>
      workerQuery<{
        attempt_id: string;
        id: string;
        node_run_id: string;
      }>(
        `select outbox.id,attempt.id attempt_id,node.id node_run_id
         from app.outbox_events outbox
         join app.node_attempts attempt
           on attempt.workspace_id=outbox.workspace_id
          and attempt.id=outbox.aggregate_id
         join app.node_runs node
           on node.workspace_id=attempt.workspace_id
          and node.id=attempt.node_run_id
         where outbox.workspace_id=$1 and node.workflow_run_id=$2
           and outbox.job_name='execute-node-attempt'
           and not (outbox.id=any($3::uuid[]))
         order by outbox.created_at,outbox.id`,
        [workspaceId, runId, excludedIds],
      ),
    (value) => value.length > 0,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('attempt outbox missing');
  return {
    attemptId: row.attempt_id,
    nodeRunId: row.node_run_id,
    outboxEventId: row.id,
  };
}

async function waitForCoordinatorOutbox(
  runId: string,
  excludedIds: readonly string[],
): Promise<string> {
  const rows = await waitFor(
    () =>
      workerQuery<{ id: string }>(
        `select id from app.outbox_events
         where workspace_id=$1 and aggregate_id=$2
           and job_name='advance-workflow-run'
           and not (id=any($3::uuid[]))
         order by created_at,id`,
        [workspaceId, runId, excludedIds],
      ),
    (value) => value.length > 0,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('coordinator outbox missing');
  return row.id;
}

describeIntegration('Phase 3 coordinator consumer', () => {
  beforeAll(setupFixture);
  afterAll(cleanupFixture);

  it('advances an accepted V2 run once across exact BullMQ redelivery', async () => {
    const accepted = await acceptRun();
    const runtime = await createCoordinatorRuntime({
      database: parseDatabaseConfig({ connectionString: workerUrl, max: 4 }),
      maximumAdmissions: 1,
      redisUrl,
    });
    const producer = createQueueProducer({ redisUrl });
    const queue = new Queue(QUEUE_NAME.workflowCoordinator, {
      connection: redisConnection(),
    });
    const job = {
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        schemaVersion: 1 as const,
        workspaceId,
        runId: accepted.runId,
        outboxEventId: accepted.outboxEventId,
      },
    };

    try {
      await Promise.all([
        runtime.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      const published = await producer.publish(job);
      const firstTransition = await waitFor(
        async () => {
          const [rows, queuedJob] = await Promise.all([
            workerQuery<{ revision: number }>(
              `select revision from app.run_checkpoints
               where workspace_id = $1 and workflow_run_id = $2`,
              [workspaceId, accepted.runId],
            ),
            queue.getJob(published.jobId),
          ]);
          return {
            revision: rows[0]?.revision,
            failedReason: queuedJob?.failedReason,
            state: await queuedJob?.getState(),
          };
        },
        (value) => value.revision === 1 || value.state === 'failed',
      );
      if (firstTransition.revision !== 1)
        throw new Error(
          `coordinator job failed: ${firstTransition.failedReason ?? 'unknown'}`,
        );
      const facts = await workerQuery<{
        attempt_count: string;
        event_types: string[];
        node_count: string;
        pending_attempt_jobs: string;
      }>(
        `select
           (select count(*)::text from app.node_runs
             where workspace_id = $1 and workflow_run_id = $2) as node_count,
           (select count(*)::text from app.node_attempts attempt
             join app.node_runs node on node.workspace_id = attempt.workspace_id
              and node.id = attempt.node_run_id
             where node.workspace_id = $1 and node.workflow_run_id = $2) as attempt_count,
           (select array_agg(type order by sequence) from app.run_events
             where workspace_id = $1 and workflow_run_id = $2) as event_types,
           (select count(*)::text from app.outbox_events
             where workspace_id = $1 and payload->>'runId' = $2::text
               and job_name = 'execute-node-attempt'
               and published_at is null and failed_at is null) as pending_attempt_jobs`,
        [workspaceId, accepted.runId],
      );
      expect(facts).toEqual([
        {
          node_count: '1',
          attempt_count: '1',
          event_types: ['run.queued', 'run.started', 'node.ready'],
          pending_attempt_jobs: '1',
        },
      ]);

      const firstJob = await waitFor(
        () => queue.getJob(published.jobId),
        (value) => value !== undefined,
      );
      if (firstJob === undefined) throw new Error('first job disappeared');
      await waitFor(
        () => firstJob.getState(),
        (state) => state === 'completed',
      );
      await firstJob.remove();
      await producer.publish(job);
      const replay = await waitFor(
        () => queue.getJob(published.jobId),
        (value) => value !== undefined,
      );
      if (replay === undefined) throw new Error('replayed job disappeared');
      await waitFor(
        () => replay.getState(),
        (state) => state === 'completed',
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      await expect(
        workerQuery<{ attempts: string; events: string; revision: number }>(
          `select checkpoint.revision,
             (select count(*)::text from app.run_events event
               where event.workspace_id = checkpoint.workspace_id
                 and event.workflow_run_id = checkpoint.workflow_run_id) as events,
             (select count(*)::text from app.node_attempts attempt
               join app.node_runs node on node.workspace_id = attempt.workspace_id
                and node.id = attempt.node_run_id
               where node.workspace_id = checkpoint.workspace_id
                 and node.workflow_run_id = checkpoint.workflow_run_id) as attempts
           from app.run_checkpoints checkpoint
           where checkpoint.workspace_id = $1
             and checkpoint.workflow_run_id = $2`,
          [workspaceId, accepted.runId],
        ),
      ).resolves.toEqual([{ revision: 1, events: '3', attempts: '1' }]);
    } finally {
      await Promise.allSettled([
        producer.close(),
        runtime.close(),
        queue.close(),
      ]);
    }
  });

  it('executes Manual through Set/Map to Terminate across durable coordinator continuations', async () => {
    const accepted = await acceptRun();
    const database = parseDatabaseConfig({
      connectionString: workerUrl,
      max: 6,
    });
    const coordinator = await createCoordinatorRuntime({
      database,
      maximumAdmissions: 1,
      redisUrl,
    });
    const attempts = await createNodeAttemptRuntime({
      database,
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 10,
      redisUrl,
      workerId: `integration-${randomUUID()}`,
    });
    const producer = createQueueProducer({ redisUrl });
    const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
      connection: redisConnection(),
    });
    const coordinatorOutboxes = [accepted.outboxEventId];
    const attemptOutboxes: string[] = [];

    try {
      await Promise.all([
        coordinator.consumer.waitUntilReady(5_000),
        attempts.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      const initialJob = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId: accepted.outboxEventId,
        },
      });
      const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
        connection: redisConnection(),
      });
      const initialTransition = await waitFor(
        async () => {
          const [rows, queued] = await Promise.all([
            workerQuery<{ revision: number }>(
              `select revision from app.run_checkpoints
               where workspace_id=$1 and workflow_run_id=$2`,
              [workspaceId, accepted.runId],
            ),
            coordinatorQueue.getJob(initialJob.jobId),
          ]);
          return {
            revision: rows[0]?.revision,
            state: await queued?.getState(),
            failedReason: queued?.failedReason,
          };
        },
        (value) => value.revision === 1 || value.state === 'failed',
      );
      await coordinatorQueue.close();
      if (initialTransition.revision !== 1)
        throw new Error(
          `initial coordinator failed: ${initialTransition.failedReason ?? 'unknown'}`,
        );

      for (const expectedNodeId of ['manual', 'set', 'terminate'] as const) {
        const attempt = await waitForAttemptOutbox(
          accepted.runId,
          attemptOutboxes,
        );
        attemptOutboxes.push(attempt.outboxEventId);
        await producer.publish({
          name: JOB_NAME.executeNodeAttempt,
          data: {
            schemaVersion: 1,
            workspaceId,
            runId: accepted.runId,
            nodeRunId: attempt.nodeRunId,
            attemptId: attempt.attemptId,
            outboxEventId: attempt.outboxEventId,
          },
        });
        await waitFor(
          () =>
            workerQuery<{ node_id: string; status: string }>(
              `select node_id,status from app.node_runs
               where workspace_id=$1 and id=$2`,
              [workspaceId, attempt.nodeRunId],
            ),
          (rows) =>
            rows[0]?.node_id === expectedNodeId &&
            rows[0].status === 'succeeded',
        );
        const completedJob = await waitFor(
          () => attemptQueue.getJob(`outbox-${attempt.outboxEventId}`),
          (job) => job !== undefined,
        );
        if (completedJob === undefined)
          throw new Error('completed attempt job disappeared');
        await waitFor(
          () => completedJob.getState(),
          (state) => state === 'completed',
        );
        await completedJob.remove();
        await producer.publish({
          name: JOB_NAME.executeNodeAttempt,
          data: {
            schemaVersion: 1,
            workspaceId,
            runId: accepted.runId,
            nodeRunId: attempt.nodeRunId,
            attemptId: attempt.attemptId,
            outboxEventId: attempt.outboxEventId,
          },
        });
        const replay = await waitFor(
          () => attemptQueue.getJob(`outbox-${attempt.outboxEventId}`),
          (job) => job !== undefined,
        );
        if (replay === undefined)
          throw new Error('replayed attempt job disappeared');
        await waitFor(
          () => replay.getState(),
          (state) => state === 'completed',
        );
        const continuation = await waitForCoordinatorOutbox(
          accepted.runId,
          coordinatorOutboxes,
        );
        coordinatorOutboxes.push(continuation);
        await producer.publish({
          name: JOB_NAME.advanceWorkflowRun,
          data: {
            schemaVersion: 1,
            workspaceId,
            runId: accepted.runId,
            outboxEventId: continuation,
          },
        });
      }

      const terminal = await waitFor(
        () =>
          workerQuery<{
            event_types: string[];
            revision: number;
            status: string;
          }>(
            `select run.status,checkpoint.revision,
                    array_agg(event.type order by event.sequence) event_types
             from app.workflow_runs run
             join app.run_checkpoints checkpoint
               on checkpoint.workspace_id=run.workspace_id
              and checkpoint.workflow_run_id=run.id
             join app.run_events event
               on event.workspace_id=run.workspace_id
              and event.workflow_run_id=run.id
             where run.workspace_id=$1 and run.id=$2
             group by run.status,checkpoint.revision`,
            [workspaceId, accepted.runId],
          ),
        (rows) => rows[0]?.status === 'succeeded',
      );
      expect(terminal[0]?.revision).toBe(4);
      expect(terminal[0]?.event_types).toEqual([
        'run.queued',
        'run.started',
        'node.ready',
        'node.started',
        'node.succeeded',
        'node.ready',
        'node.started',
        'node.succeeded',
        'node.ready',
        'node.started',
        'node.succeeded',
        'run.succeeded',
      ]);
      await expect(
        workerQuery<{ output_ref: unknown }>(
          `select output_ref from app.node_runs
           where workspace_id=$1 and workflow_run_id=$2 and node_id='terminate'`,
          [workspaceId, accepted.runId],
        ),
      ).resolves.toEqual([
        {
          output_ref: {
            schemaVersion: 1,
            kind: 'inline',
            value: {
              result: {
                expression: 'world',
                fromNode: 'world',
                fromRun: 'world',
                literal: 1,
              },
            },
          },
        },
      ]);
    } finally {
      await Promise.allSettled([
        producer.close(),
        attemptQueue.close(),
        attempts.close(),
        coordinator.close(),
      ]);
    }
  });

  it('rejects and audits an outbox identity replayed with a different run payload', async () => {
    const [authoritative, target] = await Promise.all([
      acceptRun(),
      acceptRun(),
    ]);
    const runtime = await createCoordinatorRuntime({
      database: parseDatabaseConfig({ connectionString: workerUrl, max: 4 }),
      maximumAdmissions: 1,
      redisUrl,
    });
    const producer = createQueueProducer({ redisUrl });
    const queue = new Queue(QUEUE_NAME.workflowCoordinator, {
      connection: redisConnection(),
    });
    try {
      await queue.obliterate({ force: true });
      await Promise.all([
        runtime.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      const published = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: target.runId,
          outboxEventId: authoritative.outboxEventId,
        },
      });
      const forgedJob = await waitFor(
        () => queue.getJob(published.jobId),
        (value) => value !== undefined,
      );
      if (forgedJob === undefined) throw new Error('forged job disappeared');
      await waitFor(
        () => forgedJob.getState(),
        (state) => state === 'failed' || state === 'completed',
      );

      await expect(forgedJob.getState()).resolves.toBe('failed');
      await expect(
        workerQuery<{
          audit_count: string;
          event_count: string;
          inbox_count: string;
          node_count: string;
          revision: number;
        }>(
          `select checkpoint.revision,
             (select count(*)::text from app.run_events event
               where event.workspace_id=checkpoint.workspace_id
                 and event.workflow_run_id=checkpoint.workflow_run_id) event_count,
             (select count(*)::text from app.node_runs node
               where node.workspace_id=checkpoint.workspace_id
                 and node.workflow_run_id=checkpoint.workflow_run_id) node_count,
             (select count(*)::text from app.inbox_receipts receipt
               where receipt.workspace_id=checkpoint.workspace_id
                 and receipt.message_id=$3) inbox_count,
             (select count(*)::text from app.transport_security_audit_facts fact
               where fact.workspace_id=checkpoint.workspace_id
                 and fact.message_id=$3) audit_count
           from app.run_checkpoints checkpoint
           where checkpoint.workspace_id=$1
             and checkpoint.workflow_run_id=$2`,
          [workspaceId, target.runId, authoritative.outboxEventId],
        ),
      ).resolves.toEqual([
        {
          audit_count: '1',
          event_count: '1',
          inbox_count: '0',
          node_count: '0',
          revision: 0,
        },
      ]);
    } finally {
      await Promise.allSettled([
        producer.close(),
        runtime.close(),
        queue.close(),
      ]);
    }
  });
});
