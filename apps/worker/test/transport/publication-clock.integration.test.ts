import { randomUUID } from 'node:crypto';
import { JOB_NAME } from '@pertexo/queue/server';
import { OutboxDispatcher } from '../../src/transport/outbox/dispatch/outbox-dispatcher.runtime.js';
import { WorkerDrainState } from '../../src/runtime/shutdown/drain-state.js';
import { boundaries } from './outbox-dispatcher/outbox-dispatcher.fixture.js';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { createOutboxDispatcherDatabase } from '@pertexo/core/testing';
import { releaseFailedPublication } from '../../src/transport/outbox/dispatch/release.js';
import { transportMetrics } from '../support/transport/metrics.js';
import {
  describeIntegration,
  prepareWorkerPostgreSQLRedisTransportProofFixture,
  closeWorkerPostgreSQLRedisTransportProofFixture,
  insertRunEvent,
  dispatcherUrl,
  claimEventAcrossFairRounds,
} from './dispatch.fixture.js';

describeIntegration('Publication retry database clock', () => {
  beforeAll(prepareWorkerPostgreSQLRedisTransportProofFixture);
  afterAll(closeWorkerPostgreSQLRedisTransportProofFixture);
  it.each([-365, 365])(
    'keeps retry eligibility on database time with worker skew of %i days',
    async (days) => {
      const database = createOutboxDispatcherDatabase(
        parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 }),
      );
      const pool = new Pool({ connectionString: dispatcherUrl, max: 1 });
      try {
        const id = await insertRunEvent();
        const event = await claimEventAcrossFairRounds(database, id);
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + days * 86_400_000);
        await releaseFailedPublication(
          { database, metrics: transportMetrics() },
          event,
          new Error('Redis unavailable'),
          { operationTimeoutMillis: 2_000, retryDelayMillis: 30_000 },
        );
        const result = await pool.query<{
          failed_at: Date | null;
          last_error_code: string;
          remaining: string;
        }>(
          'select failed_at, last_error_code, extract(epoch from available_at-clock_timestamp())*1000 as remaining from app.outbox_events where id=$1',
          [id],
        );
        expect(result.rows[0]).toMatchObject({
          failed_at: null,
          last_error_code: 'queue.publish_failed',
        });
        expect(Number(result.rows[0]?.remaining)).toBeGreaterThan(28_000);
        expect(Number(result.rows[0]?.remaining)).toBeLessThanOrEqual(30_000);
        const due = await database.claimBatch({
          enabledJobNames: [event.jobName],
          leaseDurationMillis: 1_000,
          leaseOwner: 'clock-proof',
          leaseToken: crypto.randomUUID(),
          limit: 100,
        });
        expect(due.events.map(({ id: dueId }) => dueId)).not.toContain(id);
      } finally {
        vi.restoreAllMocks();
        await pool.end();
        await database.close();
      }
    },
  );
  it('keeps a real refused publication retryable after ten thousand attempts', async () => {
    const database = createOutboxDispatcherDatabase(
      parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 }),
    );
    const pool = new Pool({ connectionString: dispatcherUrl, max: 1 });
    const producer = boundaries([]).producer;
    producer.publish.mockRejectedValue(
      new Error('OOM command not allowed when used memory > maxmemory'),
    );
    const dispatcher = new OutboxDispatcher(database, producer, {
      drainState: new WorkerDrainState(),
      metrics: transportMetrics(),
      options: {
        batchSize: 10,
        jobNames: [JOB_NAME.advanceWorkflowRun],
        leaseDurationMillis: 30_000,
        leaseOwner: 'persistent-outage',
        retryDelayMillis: 1_000,
      },
    });
    try {
      const id = await insertRunEvent();
      await pool.query(
        'update app.outbox_events set publish_attempts=9999 where id=$1',
        [id],
      );
      expect(await dispatcher.dispatchOnce()).toMatchObject({
        claimed: 1,
        failed: 1,
        published: 0,
      });
      const result = await pool.query<{
        failed_at: Date | null;
        last_error_code: string;
        publish_attempts: number;
        remaining: string;
        lease_owner: string | null;
      }>(
        'select failed_at,last_error_code,publish_attempts,lease_owner,extract(epoch from available_at-clock_timestamp())*1000 as remaining from app.outbox_events where id=$1',
        [id],
      );
      expect(result.rows[0]).toMatchObject({
        failed_at: null,
        last_error_code: 'queue.publish_failed',
        publish_attempts: 10000,
        lease_owner: null,
      });
      expect(Number(result.rows[0]?.remaining)).toBeGreaterThan(28_000);
      expect(Number(result.rows[0]?.remaining)).toBeLessThanOrEqual(30_000);
      const claim = {
        enabledJobNames: [JOB_NAME.advanceWorkflowRun],
        leaseDurationMillis: 1000,
        leaseOwner: 'after-outage',
        leaseToken: randomUUID(),
        limit: 100,
      };
      expect(
        (await database.claimBatch(claim)).events.map((event) => event.id),
      ).not.toContain(id);
      await pool.query(
        'update app.outbox_events set available_at=clock_timestamp() where id=$1',
        [id],
      );
      expect(
        (await database.claimBatch({ ...claim, leaseToken: randomUUID() }))
          .events,
      ).toEqual([expect.objectContaining({ id, publishAttempts: 10001 })]);
    } finally {
      await pool.end();
      await dispatcher.close();
    }
  });
});
