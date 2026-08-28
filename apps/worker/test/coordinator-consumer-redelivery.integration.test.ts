import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  JOB_NAME,
  QUEUE_NAME,
  Queue,
  acceptRun,
  cleanupFixture,
  createCoordinatorRuntime,
  createQueueProducer,
  databaseUrl,
  enabled,
  parseDatabaseConfig,
  redisConnection,
  redisUrl,
  restoreServices,
  setupFixture,
  waitFor,
  workerQuery,
  workerUrl,
  workspaceId,
} from './coordinator-consumer.fixtures.js';

const describeIntegration = enabled ? describe : describe.skip;

describeIntegration('Coordinator exact redelivery resilience', () => {
  beforeAll(setupFixture, 60_000);
  afterAll(async () => {
    await restoreServices();
    await cleanupFixture();
  });

  it('advances an accepted V2 run once across exact BullMQ redelivery', async () => {
    const accepted = await acceptRun();
    const runtime = await createCoordinatorRuntime({
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 4,
      }),
      maximumAdmissions: 1,
      releaseCohort: 'for_each_activation',
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
});
