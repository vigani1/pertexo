import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME, QUEUE_NAME } from '@pertexo/queue';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCoordinatorRuntime } from '../src/execution/coordinator-runtime.js';
import { coordinatorFixture } from './coordinator-consumer.fixtures.js';
import { acceptRun } from './support/coordinator-run-fixtures.js';

const {
  databaseUrl,
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

describeIntegration('Coordinator transport identity fencing', () => {
  beforeAll(setup, 60_000);
  afterAll(restoreServicesAndClose);

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
    let scenarioError: unknown;
    try {
      const runSnapshotBefore = await workerQuery<{
        completed_at: Date | null;
        id: string;
        status: string;
        workflow_id: string;
        workflow_version_id: string;
      }>(
        `select id,status,workflow_id,workflow_version_id,completed_at
           from app.workflow_runs
          where workspace_id=$1 and id=any($2::uuid[])
          order by id`,
        [workspaceId, [authoritative.runId, target.runId]],
      );
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
          audit_consumer: string | null;
          audit_fact_type: string | null;
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
               (select fact.consumer_name from app.transport_security_audit_facts fact
                 where fact.workspace_id=checkpoint.workspace_id
                   and fact.message_id=$3) audit_consumer,
               (select fact.fact_type from app.transport_security_audit_facts fact
                 where fact.workspace_id=checkpoint.workspace_id
                   and fact.message_id=$3) audit_fact_type
             from app.run_checkpoints checkpoint
             where checkpoint.workspace_id=$1
               and checkpoint.workflow_run_id=$2`,
          [workspaceId, target.runId, authoritative.outboxEventId],
        ),
      ).resolves.toEqual([
        {
          audit_consumer: 'workflow-coordinator',
          audit_fact_type: 'inbox_checksum_mismatch',
          event_count: '1',
          inbox_count: '0',
          node_count: '0',
          revision: 0,
        },
      ]);
      await expect(
        workerQuery<{
          completed_at: Date | null;
          id: string;
          status: string;
          workflow_id: string;
          workflow_version_id: string;
        }>(
          `select id,status,workflow_id,workflow_version_id,completed_at
             from app.workflow_runs
            where workspace_id=$1 and id=any($2::uuid[])
            order by id`,
          [workspaceId, [authoritative.runId, target.runId]],
        ),
      ).resolves.toEqual(runSnapshotBefore);
    } catch (error: unknown) {
      scenarioError = error;
    }
    const cleanupErrors: unknown[] = [];
    for (const close of [
      () => runtime.close(),
      () => producer.close(),
      () => queue.close(),
    ])
      await Promise.resolve()
        .then(close)
        .catch((error: unknown) => {
          cleanupErrors.push(error);
        });
    if (scenarioError !== undefined && cleanupErrors.length > 0)
      throw new AggregateError(
        [scenarioError, ...cleanupErrors],
        'Coordinator identity scenario and cleanup failed',
      );
    if (scenarioError !== undefined)
      throw scenarioError instanceof Error
        ? scenarioError
        : new Error('Coordinator identity scenario failed', {
            cause: scenarioError,
          });
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        cleanupErrors,
        'Coordinator identity fixture cleanup failed',
      );
  });
});
