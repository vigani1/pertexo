import { randomUUID } from 'node:crypto';
import { createDeadlineWakeupScanner } from '@pertexo/core/testing';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import { createQueueProducer, JOB_NAME, QUEUE_NAME } from '@pertexo/queue';
import { invocationKey, parseCheckpoint } from '@pertexo/workflow-engine';
import { Queue } from 'bullmq';

import { expect, it } from 'vitest';
import { createCoordinatorRuntime } from '../../../../src/runs/runtime.js';

import {
  acceptWaitRun,
  cancelFixtureRun,
  waitForAttemptOutbox,
  waitForCoordinatorOutbox,
} from '../../../support/coordinator/runs.js';
import {
  databaseUrl,
  dispatcherUrl,
  ownerQuery,
  redisConnection,
  redisUrl,
  waitFor,
  waitWorkflowVersionId,
  workerQuery,
  workerUrl,
  workspaceId,
} from './fixture.js';
import { testNodeAttemptRuntime } from '../../../support/runtime-factories.js';

export function registerCommitsSimultaneousCancellationDeadlineFactsAgainst(): void {
  it('commits simultaneous cancellation and deadline facts against a genuinely suspended Wait', async () => {
    const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
      connection: redisConnection(),
    });
    const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
      connection: redisConnection(),
    });
    await Promise.all([
      coordinatorQueue.obliterate({ force: true }),
      attemptQueue.obliterate({ force: true }),
    ]);
    const accepted = await acceptWaitRun();
    const database = parseDatabaseConfig({
      connectionString: databaseUrl(workerUrl),
      max: 6,
    });
    const producer = createQueueProducer({ redisUrl });
    let coordinator = await createCoordinatorRuntime({
      maintenanceDatabase: parseDatabaseConfig({
        connectionString: databaseUrl(dispatcherUrl),
        max: 2,
      }),
      database,
      maximumAdmissions: 1,
      redisUrl,
    });
    const attempts = await testNodeAttemptRuntime(
      {
        database,
        heartbeatIntervalMillis: 1_000,
        leaseDurationSeconds: 10,
        redisUrl,
        workerId: `wait-control-${randomUUID()}`,
      },
      {
        registry: createPlatformNodeRegistry(),
        runtimeCapabilities: {
          connections: () => ({
            resolve: () => Promise.reject(new Error('not used')),
          }),
          artifacts: () => ({
            write: () => Promise.reject(new Error('not used')),
          }),
        },
      },
    );
    const coordinatorOutboxes = [accepted.outboxEventId];
    const attemptOutboxes: string[] = [];
    const publishCoordinator = async (
      outboxEventId: string,
      expectedRevision: number,
    ) => {
      const published = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
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
            stacktrace: job?.stacktrace,
            state: await job?.getState(),
          };
        },
        ({ revision, state }) =>
          state === 'failed' ||
          (revision === expectedRevision && state === 'completed'),
      );
      if (result.state !== 'completed')
        throw new Error(
          `Wait coordinator failed: ${result.failedReason ?? 'unknown'} ${JSON.stringify(result.stacktrace)}`,
        );
    };
    const execute = async (
      expectedNodeId: 'manual' | 'wait',
      expectedStatus: 'succeeded' | 'waiting',
    ) => {
      const attempt = await waitForAttemptOutbox(
        accepted.runId,
        attemptOutboxes,
      );
      attemptOutboxes.push(attempt.outboxEventId);
      const published = await producer.publish({
        name: JOB_NAME.executeNodeAttempt,
        data: {
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
            nodeId: rows[0]?.node_id,
            state: await job?.getState(),
            status: rows[0]?.status,
          };
        },
        ({ state, status }) =>
          state === 'failed' ||
          (status === expectedStatus && state === 'completed'),
      );
      if (
        result.state !== 'completed' ||
        result.nodeId !== expectedNodeId ||
        result.status !== expectedStatus
      )
        throw new Error(
          `Wait attempt failed: ${result.failedReason ?? 'unknown'}`,
        );
    };

    try {
      await Promise.all([
        coordinator.consumer.waitUntilReady(5_000),
        attempts.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      await publishCoordinator(accepted.outboxEventId, 1);
      await execute('manual', 'succeeded');
      const manualContinuation = await waitForCoordinatorOutbox(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(manualContinuation);
      await publishCoordinator(manualContinuation, 2);
      await execute('wait', 'waiting');
      const waitContinuation = await waitForCoordinatorOutbox(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(waitContinuation);
      await publishCoordinator(waitContinuation, 3);
      const waiting = await workerQuery<{
        resume_at: Date | null;
        scheduler_state: unknown;
        status: string;
        wait_kind: string | null;
      }>(
        `select node.status,node.resume_at,node.wait_kind,checkpoint.scheduler_state
             from app.node_runs node
             join app.run_checkpoints checkpoint
               on checkpoint.workflow_run_id=node.workflow_run_id
            where node.workspace_id=$1 and node.workflow_run_id=$2
              and node.node_id='wait'`,
        [workspaceId, accepted.runId],
      );
      expect(waiting).toHaveLength(1);
      expect(waiting[0]?.resume_at).toBeInstanceOf(Date);
      expect(waiting[0]).toMatchObject({
        status: 'waiting',
        wait_kind: 'node_wait',
      });

      await Promise.all([attempts.close(), coordinator.close()]);
      await ownerQuery(
        `update app.workflow_runs
            set deadline_at=created_at+interval '1 millisecond',
                deadline_wakeup_at=null,updated_at=clock_timestamp()
          where workspace_id=$1 and id=$2`,
        [workspaceId, accepted.runId],
      );
      const scanner = createDeadlineWakeupScanner(database);
      try {
        await expect(scanner.claimDueWakeups(10)).resolves.toBe(1);
      } finally {
        await scanner.close();
      }
      await cancelFixtureRun(
        accepted.runId,
        'cancel wins simultaneous Wait deadline',
      );
      const controlOutboxes = await waitFor(
        () =>
          workerQuery<{ id: string }>(
            `select id from app.outbox_events
               where workspace_id=$1 and aggregate_id=$2
                 and job_name='advance-workflow-run'
                 and not (id=any($3::uuid[]))
               order by created_at,id`,
            [workspaceId, accepted.runId, coordinatorOutboxes],
          ),
        (rows) => rows.length === 2,
      );
      const firstControlOutbox = controlOutboxes[0]?.id;
      const secondControlOutbox = controlOutboxes[1]?.id;
      if (firstControlOutbox === undefined || secondControlOutbox === undefined)
        throw new Error('Wait control outboxes are incomplete');

      coordinator = await createCoordinatorRuntime({
        maintenanceDatabase: parseDatabaseConfig({
          connectionString: databaseUrl(dispatcherUrl),
          max: 2,
        }),
        database,
        maximumAdmissions: 1,
        redisUrl,
      });
      await coordinator.consumer.waitUntilReady(5_000);
      await publishCoordinator(firstControlOutbox, 4);
      const terminal = await workerQuery<{
        attempt_count: string;
        attempt_outboxes: string;
        cancel_events: string;
        canceled_events: string;
        scheduler_state: unknown;
        status: string;
        timed_out_events: string;
        wait_kind: string | null;
        resume_at: Date | null;
      }>(
        `select run.status,checkpoint.scheduler_state,
                wait_node.wait_kind,wait_node.resume_at,
                (select count(*)::text from app.node_attempts attempt
                  join app.node_runs node on node.id=attempt.node_run_id
                 where node.workspace_id=run.workspace_id
                   and node.workflow_run_id=run.id) attempt_count,
                (select count(*)::text from app.outbox_events outbox
                 where outbox.payload->>'runId'=run.id::text
                   and outbox.job_name='execute-node-attempt') attempt_outboxes,
                (select count(*)::text from app.run_events event
                 where event.workflow_run_id=run.id
                   and event.type='run.cancel_requested') cancel_events,
                (select count(*)::text from app.run_events event
                 where event.workflow_run_id=run.id
                   and event.type='node.canceled') canceled_events,
                (select count(*)::text from app.run_events event
                 where event.workflow_run_id=run.id
                   and event.type='node.timed_out') timed_out_events
           from app.workflow_runs run
           join app.run_checkpoints checkpoint on checkpoint.workflow_run_id=run.id
           join app.node_runs wait_node on wait_node.workflow_run_id=run.id
             and wait_node.node_id='wait'
          where run.workspace_id=$1 and run.id=$2`,
        [workspaceId, accepted.runId],
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({
        attempt_count: '2',
        attempt_outboxes: '2',
        cancel_events: '1',
        canceled_events: '1',
        resume_at: null,
        status: 'canceled',
        timed_out_events: '0',
        wait_kind: null,
      });
      const terminalCheckpoint = parseCheckpoint(terminal[0]?.scheduler_state);
      expect(terminalCheckpoint).toMatchObject({
        cancelRequested: true,
        deadlineExpired: true,
        runStatus: 'canceled',
      });
      expect(
        terminalCheckpoint.invocations.find(({ nodeId }) => nodeId === 'wait'),
      ).toMatchObject({ nodeId: 'wait', status: 'canceled' });

      await coordinator.close();
      coordinator = await createCoordinatorRuntime({
        maintenanceDatabase: parseDatabaseConfig({
          connectionString: databaseUrl(dispatcherUrl),
          max: 2,
        }),
        database,
        maximumAdmissions: 1,
        redisUrl,
      });
      await coordinator.consumer.waitUntilReady(5_000);
      await publishCoordinator(secondControlOutbox, 4);
      await expect(
        workerQuery<{
          attempts: string;
          events: string;
          revision: number;
        }>(
          `select checkpoint.revision,
                  (select count(*)::text from app.node_attempts attempt
                    join app.node_runs node on node.id=attempt.node_run_id
                   where node.workflow_run_id=$2) attempts,
                  (select count(*)::text from app.run_events event
                   where event.workflow_run_id=$2) events
             from app.run_checkpoints checkpoint
            where checkpoint.workspace_id=$1
              and checkpoint.workflow_run_id=$2`,
          [workspaceId, accepted.runId],
        ),
      ).resolves.toEqual([
        {
          attempts: '2',
          events: '12',
          revision: 4,
        },
      ]);
      expect(
        invocationKey({
          workflowVersionId: waitWorkflowVersionId,
          nodeId: 'wait',
        }),
      ).toBe(
        terminalCheckpoint.invocations.find(({ nodeId }) => nodeId === 'wait')
          ?.invocationKey,
      );
    } finally {
      await Promise.allSettled([
        attempts.close(),
        coordinator.close(),
        producer.close(),
        attemptQueue.close(),
        coordinatorQueue.close(),
      ]);
    }
  }, 60_000);
}
