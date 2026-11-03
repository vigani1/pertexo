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
} from './dispatch/fixture.js';

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
        const result = await pool.query(
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
});
