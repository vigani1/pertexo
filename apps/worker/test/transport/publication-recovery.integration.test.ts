import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOutboxDispatcherDatabase } from '@pertexo/core/testing';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  createQueueProducer,
  JOB_NAME,
  QUEUE_NAME,
} from '@pertexo/queue/server';
import { OutboxDispatcher } from '../../src/transport/outbox/dispatch/outbox-dispatcher.runtime.js';
import { WorkerDrainState } from '../../src/runtime/shutdown/drain-state.js';
import {
  describeIntegration,
  prepareWorkerPostgreSQLRedisTransportProofFixture,
  closeWorkerPostgreSQLRedisTransportProofFixture,
  dispatcherUrl,
  insertRunEvent,
  redisUrl,
  redisConnection,
} from './dispatch.fixture.js';

describeIntegration('publication recovery after real Redis refusals', () => {
  beforeAll(prepareWorkerPostgreSQLRedisTransportProofFixture);
  afterAll(closeWorkerPostgreSQLRedisTransportProofFixture);

  it('keeps high-count refusals due on database time and publishes the same durable event after recovery', async () => {
    const username = `retry-${randomUUID()}`;
    const password = randomUUID();
    const redis = new Redis(redisUrl);
    const url = new URL(redisUrl);
    url.username = username;
    url.password = password;
    // Refuse writes only for this producer, leaving other tests' Redis users alone.
    await redis.acl(
      'SETUSER',
      username,
      'on',
      `>${password}`,
      '~*',
      '&*',
      '+@all',
    );
    const database = createOutboxDispatcherDatabase(
      parseDatabaseConfig({
        connectionString: dispatcherUrl,
        max: 1,
      }),
    );
    const producer = createQueueProducer({ redisUrl: url.toString() });
    const dispatcher = new OutboxDispatcher(database, producer, {
      drainState: new WorkerDrainState(),
      options: {
        batchSize: 10,
        jobNames: [JOB_NAME.advanceWorkflowRun],
        leaseDurationMillis: 30_000,
        leaseOwner: 'redis-refusal-proof',
        operationTimeoutMillis: 5_000,
        retryDelayMillis: 1_000,
      },
    });
    const pool = new Pool({ connectionString: dispatcherUrl, max: 1 });
    const queue = new Queue<{ outboxEventId: string }>(
      QUEUE_NAME.workflowCoordinator,
      {
        connection: redisConnection(),
      },
    );
    try {
      await producer.waitUntilReady();
      await redis.acl('SETUSER', username, '-@write');
      const id = await insertRunEvent();
      await pool.query(
        'update app.outbox_events set publish_attempts=9999 where id=$1',
        [id],
      );
      for (const attempts of [10000, 10001]) {
        expect(await dispatcher.dispatchOnce()).toMatchObject({
          claimed: 1,
          failed: 1,
          published: 0,
        });
        const rows = await pool.query<{
          failed_at: Date | null;
          published_at: Date | null;
          lease_owner: string | null;
          last_error_code: string;
          publish_attempts: number;
          remaining: string;
        }>(
          `select failed_at,published_at,lease_owner,last_error_code,publish_attempts,
          extract(epoch from available_at-clock_timestamp())*1000 remaining
          from app.outbox_events where id=$1`,
          [id],
        );
        expect(rows.rows).toEqual([
          {
            failed_at: null,
            published_at: null,
            lease_owner: null,
            last_error_code: 'queue.publish_failed',
            publish_attempts: attempts,
            remaining: expect.any(String) as unknown,
          },
        ]);
        expect(Number(rows.rows[0]?.remaining)).toBeGreaterThan(28_000);
        expect(Number(rows.rows[0]?.remaining)).toBeLessThanOrEqual(30_000);
        expect(await queue.getJob(`outbox-${id}`)).toBeUndefined();
        expect(await dispatcher.dispatchOnce()).toMatchObject({
          claimed: 0,
          published: 0,
        });
        // Move to the recorded retry instant without spending a minute in this test.
        await pool.query(
          'update app.outbox_events set available_at=clock_timestamp() where id=$1',
          [id],
        );
      }
      await redis.acl('SETUSER', username, '+@write');
      expect(await dispatcher.dispatchOnce()).toMatchObject({
        claimed: 1,
        published: 1,
        failed: 0,
      });
      expect(
        (
          await pool.query(
            `select published_at is not null published,failed_at,lease_owner,publish_attempts
        from app.outbox_events where id=$1`,
            [id],
          )
        ).rows,
      ).toEqual([
        {
          published: true,
          failed_at: null,
          lease_owner: null,
          publish_attempts: 10002,
        },
      ]);
      const job = await queue.getJob(`outbox-${id}`);
      expect(job?.data).toMatchObject({ outboxEventId: id });
      expect(await dispatcher.dispatchOnce()).toMatchObject({
        claimed: 0,
        published: 0,
      });
      expect(
        (await queue.getJobs(['wait', 'delayed', 'active'])).map(
          (job) => job.data.outboxEventId,
        ),
      ).toEqual([id]);
    } finally {
      await dispatcher.close();
      await queue.close();
      await pool.end();
      await redis.acl('DELUSER', username);
      redis.disconnect();
    }
  });
});
