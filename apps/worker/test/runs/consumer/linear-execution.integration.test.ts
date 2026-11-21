import { randomUUID } from 'node:crypto';

import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { CORE_INLINE_DEFINITION_VERSION } from '@pertexo/workflow-model';
import { acceptFixtureRun } from '../../support/coordinator/runs/accept.js';
import { insertCompiledWorkflow } from '../../support/coordinator/workflows.js';
import { linearNodeFacts, logicalNodeFact } from './linear-node-facts.js';
import { linearGraph } from '../../support/coordinator/workflows/graphs/basic.js';
import { parseDatabaseConfig } from '@pertexo/database/testing';

import { createPlatformNodeRegistry } from '../../../src/providers/node-registry.js';
import {
  createQueueProducer,
  JOB_NAME,
  QUEUE_NAME,
  runEventChannel,
} from '@pertexo/queue/server';
import { Redis } from 'ioredis';
import { invocationKey } from '@pertexo/workflow-engine/server';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createCoordinatorRuntime } from '../../../src/runs/coordinator.runtime.js';
import { coordinatorFixture } from '../../support/coordinator/consumer.js';
import {
  waitForAttemptOutbox,
  waitForCoordinatorOutbox,
} from '../../support/coordinator/runs.js';
import { testNodeAttemptRuntime } from '../../support/runtime-factories.js';

const {
  databaseUrl,
  dispatcherUrl,
  enabled,
  redisConnection,
  redisUrl,
  restoreServicesAndClose,
  setup,
  waitFor,
  workerQuery,
  workerUrl,
  workspaceId,
} = coordinatorFixture;
const describeIntegration = enabled ? describe : describe.skip;

describeIntegration('Linear node execution resilience', () => {
  const workflowId = randomUUID();
  const workflowVersionId = randomUUID();
  beforeAll(async () => {
    await setup();
    const graph = linearGraph();
    await insertCompiledWorkflow(coordinatorFixture.ownerQuery, {
      actorId: coordinatorFixture.actorId,
      workspaceId,
      identity: { workflowId, workflowVersionId },
      graph: {
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.definition.key === 'core.set'
            ? {
                ...node,
                definition: {
                  key: node.definition.key,
                  version: CORE_INLINE_DEFINITION_VERSION,
                },
              }
            : node,
        ),
      },
      name: 'Linear execution parity',
      catalog: PLATFORM_NODE_CATALOG,
    });
  }, 60_000);
  afterAll(restoreServicesAndClose);

  it.each([false, true])('preserves run history (inline=%s)', verifyHistory);

  async function verifyHistory(inlineSteps: boolean) {
    const accepted = await acceptFixtureRun({
      workflowId,
      workflowVersionId,
      iterationBudget: 0,
      runInput: { name: 'Ada' },
    });
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
      maintenanceDatabase: parseDatabaseConfig({
        connectionString: databaseUrl(dispatcherUrl),
        max: 2,
      }),
      database,
      maximumAdmissions: 1,
      inlineSteps,
      redisUrl,
    });
    const attempts = await testNodeAttemptRuntime(
      {
        database,
        heartbeatIntervalMillis: 1_000,
        leaseDurationSeconds: 10,
        redisUrl,
        workerId: `integration-${randomUUID()}`,
      },
      {
        registry: createPlatformNodeRegistry({
          httpRequest: {
            httpClient: {
              redactText: (value: string) => value,
              executeStreaming: httpRequest,
            },
          },
        }),
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
    // Open run views learn of each committed transition through this channel.
    const viewer = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    const liveMessages: string[] = [];
    viewer.on('message', (_channel: string, message: string) => {
      liveMessages.push(message);
    });
    await viewer.subscribe(runEventChannel(workspaceId, accepted.runId));

    try {
      await Promise.all([
        coordinator.consumer.waitUntilReady(5_000),
        attempts.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      const initialJob = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
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
      await vi.waitFor(() => {
        expect(
          liveMessages.map((message): unknown => JSON.parse(message)),
        ).toContainEqual({ kind: 'resync' });
      });

      const deliveredNodes = inlineSteps
        ? ['manual', 'terminate']
        : ['manual', 'set', 'terminate'];
      for (const expectedNodeId of deliveredNodes) {
        const attempt = await waitForAttemptOutbox(
          accepted.runId,
          attemptOutboxes,
        );
        attemptOutboxes.push(attempt.outboxEventId);
        await producer.publish({
          name: JOB_NAME.executeNodeAttempt,
          data: {
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
      const revision = inlineSteps ? 3 : 4;
      expect(terminal[0]?.revision).toBe(revision);
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
        delivered: boolean;
        fence_token: string;
        dispatch_marked_at: string | null;
        node_id: string;
        node_status: string;
        output_ref: unknown;
      }>(
        `select node.node_id,node.status node_status,node.output_ref,
                  attempt.id attempt_id,attempt.status attempt_status,attempt.fence_token,
                  attempt.dispatch_marked_at,
                  exists (
                    select from app.outbox_events outbox
                    where outbox.workspace_id=node.workspace_id and outbox.aggregate_id=attempt.id
                      and outbox.job_name='execute-node-attempt'
                  ) as delivered
           from app.node_runs node
           join app.node_attempts attempt
             on attempt.workspace_id=node.workspace_id
            and attempt.id=node.current_attempt_id
           where node.workspace_id=$1 and node.workflow_run_id=$2
           order by case node.node_id when 'manual' then 1 when 'set' then 2 else 3 end`,
        [workspaceId, accepted.runId],
      );
      expect(nodeFacts.map(logicalNodeFact)).toEqual(linearNodeFacts);
      expect(nodeFacts.filter(({ delivered }) => !delivered)).toEqual(
        inlineSteps
          ? [
              expect.objectContaining({
                node_id: 'set',
                fence_token: '0',
                dispatch_marked_at: null,
              }),
            ]
          : [],
      );
      for (const fact of nodeFacts)
        expect(fact.attempt_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
      const invocationKeys = ['manual', 'set', 'terminate'].map((nodeId) =>
        invocationKey({ workflowVersionId, nodeId }),
      );
      expect(terminal[0]?.scheduler_state).toEqual({
        workflowVersionId,
        revision,
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
        branchSelections: [],
        initialIterationBudget: 0,
      });
    } finally {
      viewer.disconnect();
      await Promise.allSettled([
        producer.close(),
        attemptQueue.close(),
        attempts.close(),
        coordinator.close(),
      ]);
    }
  }
});
