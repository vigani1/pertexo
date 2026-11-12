import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createDatabaseRuntime } from '@pertexo/database/platform';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue/server';
import { coordinatorFixture as fixture } from '../support/coordinator/consumer.js';
import {
  acceptRun,
  createCoordinatorRedeliveryHarness,
  waitForAttemptOutbox,
} from '../support/coordinator/runs.js';
import { testNodeAttemptRuntime } from '../support/runtime-factories.js';
import { createPlatformNodeRegistry } from '../../src/providers/node-registry.js';

describe.runIf(fixture.enabled)(
  'Attempt renewal during pool contention',
  () => {
    beforeAll(fixture.setup, 60_000);
    afterAll(fixture.restoreServicesAndClose);

    it('keeps an owned attempt alive while preparation and another claim occupy the work pool', async () => {
      const deliveries = [];
      for (let n = 0; n < 2; n++) {
        const accepted = await acceptRun();
        const coordinator = await createCoordinatorRedeliveryHarness(accepted);
        try {
          await coordinator.publishInitial();
        } finally {
          await coordinator.close();
        }
        deliveries.push({
          workspaceId: fixture.workspaceId,
          runId: accepted.runId,
          ...(await waitForAttemptOutbox(accepted.runId)),
        });
      }
      const [owned, queued] = deliveries;
      if (owned === undefined || queued === undefined)
        throw new Error('Two prepared deliveries are required');
      const applicationName = `renewal-budget-${randomUUID()}`;
      const connection = new URL(fixture.databaseUrl(fixture.workerUrl));
      connection.searchParams.set('application_name', applicationName);
      const database = parseDatabaseConfig({
        connectionString: connection.toString(),
        max: 2,
      });
      const databaseRuntime = createDatabaseRuntime(database, {
        role: 'worker',
      });
      const runtime = await testNodeAttemptRuntime(
        {
          database,
          databaseRuntime,
          heartbeatIntervalMillis: 100,
          leaseDurationSeconds: 2,
          redisUrl: fixture.redisUrl,
          workerId: 'pool-contended-worker',
        },
        { registry: createPlatformNodeRegistry(), runtimeCapabilities: {} },
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
        await blocker.query(
          'select id from app.workflow_runs where id=$1 for update',
          [queued.runId],
        );
        const pid = await blocker.query<{ pid: number }>(
          'select pg_backend_pid() pid',
        );
        const blockedCount = () =>
          fixture.workerQuery<{ count: number }>(
            `select count(*)::int count from pg_stat_activity
         where datname=current_database() and $1=any(pg_blocking_pids(pid))`,
            [pid.rows[0]?.pid],
          );
        await producer.publish({
          name: JOB_NAME.executeNodeAttempt,
          data: owned,
        });
        await fixture.waitFor(blockedCount, (rows) => rows[0]?.count === 1);
        await producer.publish({
          name: JOB_NAME.executeNodeAttempt,
          data: queued,
        });
        await fixture.waitFor(blockedCount, (rows) => rows[0]?.count === 2);
        const leased = await fixture.workerQuery<{ lease_expires_at: Date }>(
          'select lease_expires_at from app.node_attempts where id=$1 and status=$2',
          [owned.attemptId, 'running'],
        );
        // Both work connections stay occupied beyond the latest owned lease.
        await blocker.query(
          'select pg_sleep(greatest(0,extract(epoch from ($1::timestamptz-clock_timestamp())))+0.2)',
          [leased[0]?.lease_expires_at],
        );
        expect(
          await fixture.workerQuery(
            'select lease_expires_at>clock_timestamp() live from app.node_attempts where id=$1',
            [owned.attemptId],
          ),
        ).toEqual([{ live: true }]);
        // Two occupied work connections, their shared monitor, and one renewal.
        const connections = await fixture.waitFor(
          () =>
            fixture.workerQuery<{ count: number }>(
              'select count(*)::int count from pg_stat_activity where datname=current_database() and application_name=$1',
              [applicationName],
            ),
          (rows) => (rows[0]?.count ?? 0) >= 4,
        );
        expect(connections).toEqual([{ count: 4 }]);
        await blocker.query('rollback');
        const completed = await fixture.waitFor(
          () =>
            fixture.workerQuery<{ status: string }>(
              'select status from app.node_attempts where id=$1',
              [owned.attemptId],
            ),
          (rows) => rows[0]?.status === 'succeeded',
        );
        expect(completed).toEqual([{ status: 'succeeded' }]);
      } finally {
        await blocker.query('rollback');
        blocker.release();
        try {
          await Promise.all([runtime.close(), producer.close()]);
        } finally {
          await databaseRuntime.close();
        }
      }
    });
  },
);
