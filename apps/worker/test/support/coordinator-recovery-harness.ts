import { randomUUID } from 'node:crypto';

import {
  JOB_NAME,
  QUEUE_NAME,
  Queue,
  createCoordinatorRuntime,
  createNodeAttemptRuntime,
  createPlatformNodeRegistryForRelease,
  createQueueProducer,
  redisConnection,
  redisUrl,
  waitFor,
  workerQuery,
  workspaceId,
} from '../coordinator-consumer.fixtures.js';
import {
  waitForCoordinatorOutbox,
  type waitForAttemptOutbox,
  type AcceptedRun,
} from './coordinator-run-fixtures.js';
import type { parseDatabaseConfig } from '../coordinator-consumer.fixtures.js';

type RecoveryAttempt = Awaited<ReturnType<typeof waitForAttemptOutbox>>;
type RecoveryRuntimeCapabilities = NonNullable<
  NonNullable<
    Parameters<typeof createNodeAttemptRuntime>[1]
  >['runtimeCapabilities']
>;

export interface CoordinatorRecoveryHarness {
  publishCoordinator(
    outboxEventId: string,
    expectedRevision: number,
  ): Promise<void>;
  nextCoordinatorOutbox(): Promise<string>;
  continueAfter(expectedRevision: number): Promise<string>;
  executeNext(nodeId: string, ordinal?: number): Promise<RecoveryAttempt>;
  redeliverAttempt(attempt: RecoveryAttempt): Promise<void>;
  restart(options?: Readonly<{ obliterateQueues?: boolean }>): Promise<void>;
  close(): Promise<void>;
}

interface RecoveryWorkers {
  readonly attempts: Awaited<ReturnType<typeof createNodeAttemptRuntime>>;
  readonly coordinator: Awaited<ReturnType<typeof createCoordinatorRuntime>>;
}

async function closeStartedWorkers(
  workers: RecoveryWorkers | undefined,
): Promise<void> {
  if (workers === undefined) return;
  await Promise.allSettled([
    workers.attempts.close(),
    workers.coordinator.close(),
  ]);
}

export async function createCoordinatorRecoveryHarness(input: {
  readonly accepted: AcceptedRun;
  readonly database: ReturnType<typeof parseDatabaseConfig>;
  readonly registryRelease: unknown;
  readonly runtimeCapabilities: RecoveryRuntimeCapabilities;
  readonly workerIdPrefix: string;
}): Promise<CoordinatorRecoveryHarness> {
  const producer = createQueueProducer({ redisUrl });
  const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
    connection: redisConnection(),
  });
  const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
    connection: redisConnection(),
  });

  const startWorkers = async (): Promise<RecoveryWorkers> => {
    let coordinator: RecoveryWorkers['coordinator'] | undefined;
    let attempts: RecoveryWorkers['attempts'] | undefined;
    try {
      coordinator = await createCoordinatorRuntime({
        database: input.database,
        maximumAdmissions: 10,
        releaseCohort: 'for_each_activation',
        redisUrl,
      });
      attempts = await createNodeAttemptRuntime(
        {
          database: input.database,
          heartbeatIntervalMillis: 1_000,
          leaseDurationSeconds: 10,
          releaseCohort: 'for_each_activation',
          redisUrl,
          workerId: `${input.workerIdPrefix}-${randomUUID()}`,
        },
        {
          registry: createPlatformNodeRegistryForRelease(input.registryRelease),
          runtimeCapabilities: input.runtimeCapabilities,
        },
      );
      await Promise.all([
        coordinator.consumer.waitUntilReady(5_000),
        attempts.consumer.waitUntilReady(5_000),
      ]);
      return { attempts, coordinator };
    } catch (error) {
      await Promise.allSettled([
        ...(attempts === undefined ? [] : [attempts.close()]),
        ...(coordinator === undefined ? [] : [coordinator.close()]),
      ]);
      throw error;
    }
  };

  let workers: RecoveryWorkers | undefined;
  try {
    workers = await startWorkers();
    await producer.waitUntilReady(5_000);
  } catch (error) {
    await closeStartedWorkers(workers);
    await Promise.allSettled([
      producer.close(),
      coordinatorQueue.close(),
      attemptQueue.close(),
    ]);
    throw error;
  }

  const attemptOutboxes: string[] = [];
  const coordinatorOutboxes = [input.accepted.outboxEventId];

  const publishCoordinator = async (
    outboxEventId: string,
    expectedRevision: number,
  ) => {
    const published = await producer.publish({
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        schemaVersion: 1,
        workspaceId,
        runId: input.accepted.runId,
        outboxEventId,
      },
    });
    const result = await waitFor(
      async () => {
        const [rows, job] = await Promise.all([
          workerQuery<{ revision: number }>(
            `select revision from app.run_checkpoints
               where workspace_id=$1 and workflow_run_id=$2`,
            [workspaceId, input.accepted.runId],
          ),
          coordinatorQueue.getJob(published.jobId),
        ]);
        return {
          failedReason: job?.failedReason,
          revision: rows[0]?.revision,
          state: await job?.getState(),
        };
      },
      ({ revision, state }) =>
        state === 'failed' ||
        (revision === expectedRevision &&
          (state === undefined || state === 'completed')),
    );
    if (result.state === 'failed' || result.revision !== expectedRevision)
      throw new Error(
        `Coordinator failed: ${result.failedReason ?? 'unknown'}`,
      );
  };

  const nextCoordinatorOutbox = async () => {
    const outboxEventId = await waitForCoordinatorOutbox(
      input.accepted.runId,
      coordinatorOutboxes,
    );
    coordinatorOutboxes.push(outboxEventId);
    return outboxEventId;
  };

  const continueAfter = async (expectedRevision: number) => {
    const outboxEventId = await nextCoordinatorOutbox();
    await publishCoordinator(outboxEventId, expectedRevision);
    return outboxEventId;
  };

  const executeNext = async (nodeId: string, ordinal?: number) => {
    const rows = await waitFor(
      () =>
        workerQuery<{
          attempt_id: string;
          node_run_id: string;
          outbox_id: string;
        }>(
          `select attempt.id attempt_id,node.id node_run_id,outbox.id outbox_id
             from app.outbox_events outbox
             join app.node_attempts attempt on attempt.id=outbox.aggregate_id
             join app.node_runs node on node.id=attempt.node_run_id
            where node.workspace_id=$1 and node.workflow_run_id=$2
              and node.node_id=$3 and outbox.job_name='execute-node-attempt'
              and not (outbox.id=any($4::uuid[]))
              and ($5::int is null or
                (node.branch_context->'iterationPath'->0->>'ordinal')::int=$5)
            order by outbox.created_at,outbox.id`,
          [
            workspaceId,
            input.accepted.runId,
            nodeId,
            attemptOutboxes,
            ordinal ?? null,
          ],
        ),
      (value) => value.length === 1,
    );
    const attempt = rows[0];
    if (attempt === undefined) throw new Error(`${nodeId} attempt missing`);
    attemptOutboxes.push(attempt.outbox_id);
    const published = await producer.publish({
      name: JOB_NAME.executeNodeAttempt,
      data: {
        schemaVersion: 1,
        workspaceId,
        runId: input.accepted.runId,
        nodeRunId: attempt.node_run_id,
        attemptId: attempt.attempt_id,
        outboxEventId: attempt.outbox_id,
      },
    });
    const result = await waitFor(
      async () => {
        const [rowsForAttempt, job] = await Promise.all([
          workerQuery<{ status: string }>(
            `select status from app.node_runs where workspace_id=$1 and id=$2`,
            [workspaceId, attempt.node_run_id],
          ),
          attemptQueue.getJob(published.jobId),
        ]);
        return {
          failedReason: job?.failedReason,
          state: await job?.getState(),
          status: rowsForAttempt[0]?.status,
        };
      },
      ({ state, status }) =>
        state === 'failed' ||
        (status === 'succeeded' &&
          (state === undefined || state === 'completed')),
    );
    if (result.state === 'failed' || result.status !== 'succeeded')
      throw new Error(
        `Attempt ${nodeId} failed: ${result.failedReason ?? 'unknown'}`,
      );
    return {
      attemptId: attempt.attempt_id,
      nodeRunId: attempt.node_run_id,
      outboxEventId: attempt.outbox_id,
    };
  };

  const redeliverAttempt = async (attempt: RecoveryAttempt) => {
    await producer.publish({
      name: JOB_NAME.executeNodeAttempt,
      data: {
        schemaVersion: 1,
        workspaceId,
        runId: input.accepted.runId,
        nodeRunId: attempt.nodeRunId,
        attemptId: attempt.attemptId,
        outboxEventId: attempt.outboxEventId,
      },
    });
  };

  const restart = async (
    options: Readonly<{ obliterateQueues?: boolean }> = {},
  ) => {
    if (workers === undefined) throw new Error('workers are closed');
    await Promise.all([workers.attempts.close(), workers.coordinator.close()]);
    if (options.obliterateQueues === true)
      await Promise.all([
        coordinatorQueue.obliterate({ force: true }),
        attemptQueue.obliterate({ force: true }),
      ]);
    workers = await startWorkers();
  };

  const close = async () => {
    const current = workers;
    workers = undefined;
    await Promise.allSettled([
      ...(current === undefined
        ? []
        : [current.attempts.close(), current.coordinator.close()]),
      producer.close(),
      coordinatorQueue.close(),
      attemptQueue.close(),
    ]);
  };

  return {
    publishCoordinator,
    nextCoordinatorOutbox,
    continueAfter,
    executeNext,
    redeliverAttempt,
    restart,
    close,
  };
}
