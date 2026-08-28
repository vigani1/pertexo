import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  JOB_NAME,
  QUEUE_NAME,
  Queue,
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
import { acceptRun } from './support/coordinator-run-fixtures.js';

const describeIntegration = enabled ? describe : describe.skip;

describeIntegration('Coordinator transport identity fencing', () => {
  beforeAll(setupFixture, 60_000);
  afterAll(async () => {
    await restoreServices();
    await cleanupFixture();
  });

  it('rejects and audits an outbox identity replayed with a different run payload', async () => {
    const [authoritative, target] = await Promise.all([
      acceptRun(),
      acceptRun(),
    ]);
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
