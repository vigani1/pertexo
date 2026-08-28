import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  CORE_REGISTRY_RELEASE_SUCCESSOR,
  JOB_NAME,
  PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
  QUEUE_NAME,
  Queue,
  acceptRun,
  cleanupFixture,
  composeExecutableCompatibilityRelease,
  createCoordinatorRuntime,
  createNodeAttemptRuntime,
  createPlatformNodeRegistryForRelease,
  createQueueProducer,
  databaseUrl,
  enabled,
  engineVersion,
  invocationKey,
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
  workflowVersionId,
  workspaceId,
} from './coordinator-consumer.fixtures.js';

const describeIntegration = enabled ? describe : describe.skip;

describeIntegration('Linear node execution resilience', () => {
  beforeAll(setupFixture, 60_000);
  afterAll(async () => {
    await restoreServices();
    await cleanupFixture();
  });

  it('executes Manual through Set/Map to Terminate across durable coordinator continuations', async () => {
    const accepted = await acceptRun();
    const database = parseDatabaseConfig({
      connectionString: databaseUrl(workerUrl),
      max: 6,
    });
    const connectionResolve = vi.fn(() =>
      Promise.reject(new Error('core-only run must not resolve a connection')),
    );
    const artifactWrite = vi.fn(() =>
      Promise.reject(new Error('core-only run must not write an artifact')),
    );
    const httpRequest = vi.fn(() =>
      Promise.reject(
        new Error('core-only run must not contact HTTP transport'),
      ),
    );
    const coordinator = await createCoordinatorRuntime({
      database,
      maximumAdmissions: 1,
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
        workerId: `integration-${randomUUID()}`,
      },
      {
        registry: createPlatformNodeRegistryForRelease(
          PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
          { httpRequest: { httpClient: { executeStreaming: httpRequest } } },
        ),
        runtimeCapabilities: {
          connections: () => ({ resolve: connectionResolve }),
          artifacts: () => ({ write: artifactWrite }),
        },
      },
    );
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
            scheduler_state: unknown;
            status: string;
          }>(
            `select run.status,checkpoint.revision,checkpoint.scheduler_state,
                      array_agg(event.type order by event.sequence) event_types
               from app.workflow_runs run
               join app.run_checkpoints checkpoint
                 on checkpoint.workspace_id=run.workspace_id
                and checkpoint.workflow_run_id=run.id
               join app.run_events event
                 on event.workspace_id=run.workspace_id
                and event.workflow_run_id=run.id
               where run.workspace_id=$1 and run.id=$2
                group by run.status,checkpoint.revision,checkpoint.scheduler_state`,
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
      expect(connectionResolve).not.toHaveBeenCalled();
      expect(artifactWrite).not.toHaveBeenCalled();
      expect(httpRequest).not.toHaveBeenCalled();
      const nodeFacts = await workerQuery<{
        attempt_id: string;
        attempt_status: string;
        node_id: string;
        node_status: string;
        output_ref: unknown;
      }>(
        `select node.node_id,node.status node_status,node.output_ref,
                  attempt.id attempt_id,attempt.status attempt_status
           from app.node_runs node
           join app.node_attempts attempt
             on attempt.workspace_id=node.workspace_id
            and attempt.id=node.current_attempt_id
           where node.workspace_id=$1 and node.workflow_run_id=$2
           order by case node.node_id when 'manual' then 1 when 'set' then 2 else 3 end`,
        [workspaceId, accepted.runId],
      );
      expect(
        nodeFacts.map((fact) => ({
          attempt_status: fact.attempt_status,
          node_id: fact.node_id,
          node_status: fact.node_status,
          output_ref: fact.output_ref,
        })),
      ).toEqual([
        {
          attempt_status: 'succeeded',
          node_id: 'manual',
          node_status: 'succeeded',
          output_ref: {
            schemaVersion: 1,
            kind: 'inline',
            value: { name: 'Ada' },
          },
        },
        {
          attempt_status: 'succeeded',
          node_id: 'set',
          node_status: 'succeeded',
          output_ref: {
            schemaVersion: 1,
            kind: 'inline',
            value: {
              fromRun: 'Ada',
              literal: 1,
            },
          },
        },
        {
          attempt_status: 'succeeded',
          node_id: 'terminate',
          node_status: 'succeeded',
          output_ref: {
            schemaVersion: 1,
            kind: 'inline',
            value: {
              result: {
                fromRun: 'Ada',
                literal: 1,
              },
            },
          },
        },
      ]);
      for (const fact of nodeFacts)
        expect(fact.attempt_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
      const invocationKeys = ['manual', 'set', 'terminate'].map((nodeId) =>
        invocationKey({ workflowVersionId, nodeId }),
      );
      expect(terminal[0]?.scheduler_state).toEqual({
        schemaVersion: 1,
        engineVersion,
        workflowVersionId,
        revision: 4,
        runStatus: 'succeeded',
        nextEventSequence: 13,
        readySet: [],
        admittedInvocationKeys: invocationKeys,
        invocations: nodeFacts.map((fact, index) => ({
          invocationKey: invocationKeys[index],
          nodeId: fact.node_id,
          status: 'succeeded',
          attemptNumber: 1,
          output: { kind: 'inline', attemptId: fact.attempt_id },
        })),
        joins: [],
        loops: [],
        remainingIterationBudget: 0,
        cancelRequested: false,
        deadlineExpired: false,
      });
      const epoch2 = composeExecutableCompatibilityRelease(
        CORE_REGISTRY_RELEASE_SUCCESSOR,
      );
      const epoch14 = composeExecutableCompatibilityRelease(
        PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
      );
      await expect(
        workerQuery<{
          current_epoch: number;
          current_fingerprint: string;
          executable_epoch: number;
          executable_fingerprint: string;
        }>(
          `select current.epoch current_epoch,current.fingerprint current_fingerprint,
                    version.compatibility_release_epoch executable_epoch,
                    version.executable_json->>'compatibilityReleaseFingerprint' executable_fingerprint
             from app.workflow_versions version
             cross join app.node_compatibility_current current
             where version.workspace_id=$1 and version.id=$2`,
          [workspaceId, workflowVersionId],
        ),
      ).resolves.toEqual([
        {
          current_epoch: 14,
          current_fingerprint: epoch14.fingerprint,
          executable_epoch: 2,
          executable_fingerprint: epoch2.fingerprint,
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
});
