import { parseDatabaseConfig } from '@pertexo/database/testing';

import { createQueueProducer, JOB_NAME, QUEUE_NAME } from '@pertexo/queue';

import { Queue } from 'bullmq';

import { createCoordinatorRuntime } from '../../../../src/runs/runtime.js';

import {
  databaseUrl,
  dispatcherUrl,
  redisConnection,
  redisUrl,
  waitFor,
  workerQuery,
  workerUrl,
  workspaceId,
} from './scope.js';
import type { AcceptedRun, CoordinatorRedeliveryHarness } from './contract.js';

export async function createCoordinatorRedeliveryHarness(
  accepted: AcceptedRun,
): Promise<CoordinatorRedeliveryHarness> {
  const owners: (() => void | Promise<void>)[] = [];
  let runtime: Awaited<ReturnType<typeof createCoordinatorRuntime>>;
  let producer: ReturnType<typeof createQueueProducer>;
  let queue: Queue;
  try {
    runtime = await createCoordinatorRuntime({
      maintenanceDatabase: parseDatabaseConfig({
        connectionString: databaseUrl(dispatcherUrl),
        max: 2,
      }),
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 4,
      }),
      maximumAdmissions: 1,
      redisUrl,
    });
    owners.push(() => runtime.close());
    producer = createQueueProducer({ redisUrl });
    owners.push(() => producer.close());
    queue = new Queue(QUEUE_NAME.workflowCoordinator, {
      connection: redisConnection(),
    });
    owners.push(() => queue.close());
  } catch (startupError: unknown) {
    const errors: unknown[] = [startupError];
    for (const closeOwner of owners.reverse())
      await Promise.resolve()
        .then(closeOwner)
        .catch((error: unknown) => errors.push(error));
    if (errors.length === 1) throw startupError;
    throw new AggregateError(
      errors,
      'Coordinator redelivery harness startup failed',
    );
  }
  const job = {
    name: JOB_NAME.advanceWorkflowRun,
    data: {
      workspaceId,
      runId: accepted.runId,
      outboxEventId: accepted.outboxEventId,
    },
  };
  let published: Awaited<ReturnType<typeof producer.publish>> | undefined;

  let closePromise: Promise<void> | undefined;
  const close = () => {
    closePromise ??= (async () => {
      const errors: unknown[] = [];
      for (const closeOwner of owners.reverse())
        await Promise.resolve()
          .then(closeOwner)
          .catch((error: unknown) => errors.push(error));
      if (errors.length > 0)
        throw new AggregateError(
          errors,
          'Coordinator redelivery harness cleanup failed',
        );
    })();
    return closePromise;
  };

  const publishInitial = async () => {
    await Promise.all([
      runtime.consumer.waitUntilReady(5_000),
      producer.waitUntilReady(5_000),
    ]);
    const initialPublished = await producer.publish(job);
    published = initialPublished;
    const firstTransition = await waitFor(
      async () => {
        const [rows, queuedJob] = await Promise.all([
          workerQuery<{ revision: number }>(
            `select revision from app.run_checkpoints
               where workspace_id = $1 and workflow_run_id = $2`,
            [workspaceId, accepted.runId],
          ),
          queue.getJob(initialPublished.jobId),
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
        `Coordinator redelivery failed: ${firstTransition.failedReason ?? 'unknown'}`,
      );
  };

  const redeliver = async () => {
    const currentPublished = published;
    if (currentPublished === undefined)
      throw new Error('initial job is missing');
    const firstJob = await waitFor(
      () => queue.getJob(currentPublished.jobId),
      (value) => value !== undefined,
    );
    if (firstJob === undefined) throw new Error('initial job disappeared');
    const firstState = await waitFor(
      () => firstJob.getState(),
      (state) => state === 'completed' || state === 'failed',
    );
    if (firstState !== 'completed')
      throw new Error(
        `Initial coordinator job failed: ${firstJob.failedReason}`,
      );
    await firstJob.remove();
    await producer.publish(job);
    const replay = await waitFor(
      () => queue.getJob(currentPublished.jobId),
      (value) => value !== undefined,
    );
    if (replay === undefined) throw new Error('redelivered job disappeared');
    const replayState = await waitFor(
      () => replay.getState(),
      (state) => state === 'completed' || state === 'failed',
    );
    if (replayState !== 'completed')
      throw new Error(
        `Redelivered coordinator job failed: ${replay.failedReason}`,
      );
  };

  return { publishInitial, redeliver, close };
}

export async function waitForAttemptOutbox(
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

export async function waitForCoordinatorOutbox(
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
