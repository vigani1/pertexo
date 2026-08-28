import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  JOB_NAME,
  PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
  QUEUE_NAME,
  Queue,
  acceptParallelRun,
  cleanupFixture,
  createCoordinatorRuntime,
  createNodeAttemptRuntime,
  createPlatformNodeRegistryForRelease,
  createQueueProducer,
  databaseUrl,
  enabled,
  parseCheckpoint,
  parseDatabaseConfig,
  randomUUID,
  redisConnection,
  redisUrl,
  restoreServices,
  setupFixture,
  waitFor,
  waitForAttemptOutbox,
  waitForCoordinatorOutbox,
  workerQuery,
  workerUrl,
  workspaceId,
} from './coordinator-consumer.fixtures.js';

const describeIntegration = enabled ? describe : describe.skip;

describeIntegration('Parallel and Merge Redis-loss recovery', () => {
  beforeAll(setupFixture, 60_000);
  afterAll(async () => {
    await restoreServices();
    await cleanupFixture();
  });

  it('recovers bounded Parallel and settled Merge after Redis loss on fresh workers', async () => {
    const accepted = await acceptParallelRun();
    const database = parseDatabaseConfig({
      connectionString: databaseUrl(workerUrl),
      max: 6,
    });
    const runtimeCapabilities = {
      connections: () => ({
        resolve: vi.fn(() => Promise.reject(new Error('not used'))),
      }),
      artifacts: () => ({
        write: vi.fn(() => Promise.reject(new Error('not used'))),
      }),
    };
    const startWorkers = async () => {
      const coordinator = await createCoordinatorRuntime({
        database,
        maximumAdmissions: 10,
        releaseCohort: 'for_each_activation',
        redisUrl,
      });
      const attempts = await createNodeAttemptRuntime(
        {
          database,
          heartbeatIntervalMillis: 1_000,
          leaseDurationSeconds: 10,
          releaseCohort: 'for_each_activation',
          redisUrl,
          workerId: `parallel-${randomUUID()}`,
        },
        {
          registry: createPlatformNodeRegistryForRelease(
            PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
          ),
          runtimeCapabilities,
        },
      );
      await Promise.all([
        coordinator.consumer.waitUntilReady(5_000),
        attempts.consumer.waitUntilReady(5_000),
      ]);
      return { attempts, coordinator };
    };
    const producer = createQueueProducer({ redisUrl });
    const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
      connection: redisConnection(),
    });
    const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
      connection: redisConnection(),
    });
    let workers = await startWorkers();
    const attemptOutboxes: string[] = [];
    const coordinatorOutboxes = [accepted.outboxEventId];
    const publishCoordinator = async (
      outboxEventId: string,
      expectedRevision: number,
    ) => {
      const published = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId,
        },
      });
      const result = await waitFor(
        async () => {
          const [rows, job] = await Promise.all([
            workerQuery<{ revision: number }>(
              `select revision from app.run_checkpoints
                 where workspace_id=$1 and workflow_run_id=$2`,
              [workspaceId, accepted.runId],
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
          revision === expectedRevision || state === 'failed',
      );
      if (result.revision !== expectedRevision)
        throw new Error(
          `Parallel coordinator failed: ${result.failedReason ?? 'unknown'}`,
        );
    };
    const executeNext = async (expectedNodeId: string) => {
      const attempt = await waitForAttemptOutbox(
        accepted.runId,
        attemptOutboxes,
      );
      attemptOutboxes.push(attempt.outboxEventId);
      const published = await producer.publish({
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
      const result = await waitFor(
        async () => {
          const [rows, job] = await Promise.all([
            workerQuery<{ node_id: string; status: string }>(
              `select node_id,status from app.node_runs
                 where workspace_id=$1 and id=$2`,
              [workspaceId, attempt.nodeRunId],
            ),
            attemptQueue.getJob(published.jobId),
          ]);
          return {
            failedReason: job?.failedReason,
            rows,
            state: await job?.getState(),
          };
        },
        ({ rows, state }) =>
          (rows[0]?.node_id === expectedNodeId &&
            rows[0].status === 'succeeded') ||
          state === 'failed',
      );
      if (result.rows[0]?.status !== 'succeeded')
        throw new Error(
          `Parallel attempt failed: ${result.failedReason ?? 'unknown'}`,
        );
      return attempt;
    };
    const continueAfter = async (expectedRevision: number) => {
      const outboxEventId = await waitForCoordinatorOutbox(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(outboxEventId);
      await publishCoordinator(outboxEventId, expectedRevision);
      return outboxEventId;
    };

    try {
      await producer.waitUntilReady(5_000);
      await publishCoordinator(accepted.outboxEventId, 1);
      await executeNext('manual');
      await continueAfter(2);
      const parallelAttempt = await executeNext('parallel');
      const parallelContinuation = await waitForCoordinatorOutbox(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(parallelContinuation);

      await producer.publish({
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: parallelAttempt.nodeRunId,
          attemptId: parallelAttempt.attemptId,
          outboxEventId: parallelAttempt.outboxEventId,
        },
      });
      await Promise.allSettled([
        workers.attempts.close(),
        workers.coordinator.close(),
      ]);
      await Promise.all([
        coordinatorQueue.obliterate({ force: true }),
        attemptQueue.obliterate({ force: true }),
      ]);
      workers = await startWorkers();

      await publishCoordinator(parallelContinuation, 3);
      await publishCoordinator(parallelContinuation, 3);
      const bounded = await workerQuery<{
        attempt_count: string;
        node_id: string;
        status: string;
      }>(
        `select node_id,status,
                  (select count(*)::text from app.node_attempts attempt
                    join app.node_runs attempt_node on attempt_node.id=attempt.node_run_id
                   where attempt_node.workflow_run_id=$2
                     and attempt_node.node_id in ('left','right')) attempt_count
             from app.node_runs
           where workspace_id=$1 and workflow_run_id=$2
             and node_id in ('left','right') order by node_id`,
        [workspaceId, accepted.runId],
      );
      expect(bounded).toEqual([
        { attempt_count: '1', node_id: 'left', status: 'ready' },
        { attempt_count: '1', node_id: 'right', status: 'ready' },
      ]);

      await executeNext('left');
      await continueAfter(4);
      await executeNext('right');
      await continueAfter(5);
      await executeNext('merge');
      await continueAfter(6);
      await executeNext('terminate');
      await continueAfter(7);

      const terminal = await workerQuery<{
        attempts: string;
        scheduler_state: unknown;
      }>(
        `select checkpoint.scheduler_state,
                  (select count(*)::text from app.node_attempts attempt
                    join app.node_runs node on node.id=attempt.node_run_id
                   where node.workflow_run_id=$2) attempts
             from app.run_checkpoints checkpoint
            where checkpoint.workspace_id=$1 and checkpoint.workflow_run_id=$2`,
        [workspaceId, accepted.runId],
      );
      expect(terminal[0]?.attempts).toBe('6');
      expect(parseCheckpoint(terminal[0]?.scheduler_state)).toMatchObject({
        schemaVersion: 2,
        runStatus: 'succeeded',
        joins: [
          {
            joinId: 'merge',
            selectedBranchIds: ['branch-01', 'branch-02'],
          },
        ],
      });
    } finally {
      await Promise.allSettled([
        workers.attempts.close(),
        workers.coordinator.close(),
        producer.close(),
        coordinatorQueue.close(),
        attemptQueue.close(),
      ]);
    }
  }, 30_000);
});
