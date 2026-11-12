import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeAttemptRunStore } from '@pertexo/core/attempts';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue/server';
import { coordinatorFixture as fixture } from '../support/coordinator/consumer.js';
import {
  acceptRun,
  createCoordinatorRedeliveryHarness,
  waitForAttemptOutbox,
} from '../support/coordinator/runs.js';
import { testNodeAttemptRuntime } from '../support/runtime-factories.js';
import { createPlatformNodeRegistry } from '../../src/providers/node-registry.js';

describe.runIf(fixture.enabled)('Attempt ownership during preparation', () => {
  beforeAll(fixture.setup, 60_000);
  afterAll(fixture.restoreServicesAndClose);

  it('renews its lease while waiting to read the executable, then completes', async () => {
    const accepted = await acceptRun();
    const coordinator = await createCoordinatorRedeliveryHarness(accepted);
    try {
      await coordinator.publishInitial();
    } finally {
      await coordinator.close();
    }
    const attempt = await waitForAttemptOutbox(accepted.runId);
    const runtime = await testNodeAttemptRuntime(
      {
        database: parseDatabaseConfig({
          connectionString: fixture.databaseUrl(fixture.workerUrl),
          max: 4,
        }),
        heartbeatIntervalMillis: 100,
        leaseDurationSeconds: 1,
        redisUrl: fixture.redisUrl,
        workerId: 'preparing-worker',
      },
      { registry: createPlatformNodeRegistry(), runtimeCapabilities: {} },
    );
    const competitor = createNodeAttemptRunStore(
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(fixture.workerUrl),
        max: 1,
      }),
    );
    const producer = createQueueProducer({ redisUrl: fixture.redisUrl });
    const blocker = await fixture.ownerPool.connect();
    try {
      await runtime.consumer.waitUntilReady(5_000);
      await blocker.query('begin');
      await blocker.query('set local role pertexo_owner');
      await blocker.query(
        'lock table app.workflow_versions in access exclusive mode',
      );
      const pid = await blocker.query<{ pid: number }>(
        'select pg_backend_pid() pid',
      );
      await producer.publish({
        name: JOB_NAME.executeNodeAttempt,
        data: {
          workspaceId: fixture.workspaceId,
          runId: accepted.runId,
          ...attempt,
        },
      });
      const leased = await fixture.waitFor(
        () =>
          fixture.workerQuery<{ lease_expires_at: Date; blocked: boolean }>(
            `select lease_expires_at,exists(select 1 from pg_stat_activity
            where datname=current_database() and $2=any(pg_blocking_pids(pid))) blocked
           from app.node_attempts where id=$1 and status='running'`,
            [attempt.attemptId, pid.rows[0]?.pid],
          ),
        (rows) => rows[0]?.blocked === true,
      );
      // Cross the original lease deadline while the real source read is blocked.
      await blocker.query(
        'select pg_sleep(greatest(0,extract(epoch from ($1::timestamptz-clock_timestamp())))+0.2)',
        [leased[0]?.lease_expires_at],
      );
      expect(
        await fixture.workerQuery(
          'select lease_expires_at>clock_timestamp() live from app.node_attempts where id=$1',
          [attempt.attemptId],
        ),
      ).toEqual([{ live: true }]);
      const [outbox] = await fixture.workerQuery<{ payload_checksum: string }>(
        'select payload_checksum from app.outbox_events where id=$1',
        [attempt.outboxEventId],
      );
      if (outbox === undefined) throw new Error('Delivery missing');
      await expect(
        competitor.claimDelivery({
          workspaceId: fixture.workspaceId,
          runId: accepted.runId,
          nodeRunId: attempt.nodeRunId,
          attemptId: attempt.attemptId,
          delivery: {
            outboxEventId: attempt.outboxEventId,
            payloadChecksum: outbox.payload_checksum,
          },
          workerId: 'competing-preparation-worker',
          leaseDurationSeconds: 1,
          signal: AbortSignal.timeout(5000),
        }),
      ).resolves.toEqual({ kind: 'duplicate' });
      expect(
        await fixture.workerQuery(
          'select lease_owner from app.node_attempts where id=$1',
          [attempt.attemptId],
        ),
      ).toEqual([{ lease_owner: 'preparing-worker' }]);
      await blocker.query('rollback');
      const completed = await fixture.waitFor(
        () =>
          fixture.workerQuery<{ status: string }>(
            'select status from app.node_attempts where id=$1',
            [attempt.attemptId],
          ),
        (rows) => rows[0]?.status === 'succeeded',
      );
      expect(completed).toEqual([{ status: 'succeeded' }]);
    } finally {
      await blocker.query('rollback');
      blocker.release();
      await Promise.all([
        runtime.close(),
        producer.close(),
        competitor.close(),
      ]);
    }
  });
});
