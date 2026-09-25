import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createScheduleTriggerScanner } from '../src/triggers/schedule-trigger-scanner.js';
import { BASELINE_COMPATIBILITY_EXPECTATION } from './baseline-compatibility-fixture.js';
import {
  scopedConnectionUrl,
  waitForApplicationLock,
} from './support/postgres-lock-coordination.js';
import { createScheduleTriggerTestEnvironment } from './support/schedule-triggers.integration.support.js';

const schedule = createScheduleTriggerTestEnvironment();
const { ownerQuery, skipTriggerId, triggerId } = schedule;
let racePool: Pool | undefined;

beforeAll(async () => {
  await schedule.initialize();
  racePool = new Pool({ ...schedule.worker.options, max: 2 });
  await ownerQuery(
    `update app.trigger_schedules
        set next_fire_at=clock_timestamp()+interval '1 hour'
      where trigger_id=$1`,
    [skipTriggerId],
  );
});

afterAll(async () => {
  await racePool?.end();
  await schedule.close();
});

describe('schedule claim concurrency', () => {
  it('skips a row held by one claimant and exposes only its committed fenced lease', async () => {
    if (racePool === undefined)
      throw new Error('race pool was not initialized');
    await ownerQuery(
      `update app.trigger_schedules
          set next_fire_at=clock_timestamp()-interval '1 second',
              admission_deferred_until=null,lease_owner=null,lease_token=null,
              lease_acquired_at=null,lease_expires_at=null
        where trigger_id=$1`,
      [triggerId],
    );
    const first = await racePool.connect();
    const second = await racePool.connect();
    let transactionOpen = false;
    let returnedClaim:
      Readonly<{ trigger_id: string; lease_token: string }> | undefined;
    try {
      await first.query('begin');
      transactionOpen = true;
      const held = await first.query<{
        trigger_id: string;
        lease_token: string;
      }>(
        'select trigger_id,lease_token from app.claim_due_trigger_schedules($1,1,30)',
        ['coordinated-holder'],
      );
      returnedClaim = held.rows[0];
      expect(returnedClaim?.trigger_id).toBe(triggerId);

      const skipped = await second.query(
        'select trigger_id,lease_token from app.claim_due_trigger_schedules($1,1,30)',
        ['coordinated-contender'],
      );
      expect(skipped.rows).toEqual([]);
      await first.query('commit');
      transactionOpen = false;

      await expect(
        ownerQuery<{ lease_token: string }>(
          `select lease_token::text from app.trigger_schedules
            where trigger_id=$1 and lease_expires_at>clock_timestamp()`,
          [triggerId],
        ),
      ).resolves.toMatchObject({
        rows: [{ lease_token: returnedClaim?.lease_token }],
      });
    } finally {
      if (transactionOpen) await first.query('rollback').catch(() => undefined);
      if (returnedClaim !== undefined)
        await second
          .query('select app.release_trigger_schedule_claim($1,$2)', [
            returnedClaim.trigger_id,
            returnedClaim.lease_token,
          ])
          .catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it('never returns two live claims for one due schedule under concurrent workers', async () => {
    if (racePool === undefined)
      throw new Error('race pool was not initialized');

    const pool = racePool;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      await ownerQuery(
        `update app.trigger_schedules
              set next_fire_at=clock_timestamp()-interval '1 second',
                  admission_deferred_until=null,health_status='healthy',
                  last_error_code=null,lease_owner=null,lease_token=null,
                  lease_acquired_at=null,lease_expires_at=null
            where trigger_id=$1`,
        [triggerId],
      );
      const results = await Promise.all([
        pool.query<{ trigger_id: string; lease_token: string }>(
          'select trigger_id,lease_token from app.claim_due_trigger_schedules($1,1,30)',
          [`claim-race-one-${String(attempt)}`],
        ),
        pool.query<{ trigger_id: string; lease_token: string }>(
          'select trigger_id,lease_token from app.claim_due_trigger_schedules($1,1,30)',
          [`claim-race-two-${String(attempt)}`],
        ),
      ]);
      const returnedClaims = results.flatMap((result) => result.rows);
      try {
        expect(returnedClaims, `claim race ${String(attempt)}`).toHaveLength(1);
        const live = await ownerQuery<{
          lease_token: string;
          live_leases: number;
        }>(
          `select lease_token,count(*) over ()::int live_leases
               from app.trigger_schedules
              where trigger_id=$1 and lease_token is not null
                and lease_expires_at>clock_timestamp()`,
          [triggerId],
        );
        expect(live.rows).toHaveLength(1);
        expect(live.rows[0]?.live_leases).toBe(1);
        expect(live.rows[0]?.lease_token).toBe(returnedClaims[0]?.lease_token);
      } finally {
        await Promise.allSettled(
          returnedClaims.map((claim) =>
            pool.query('select app.release_trigger_schedule_claim($1,$2)', [
              claim.trigger_id,
              claim.lease_token,
            ]),
          ),
        );
      }
    }

    const live = await ownerQuery<{ live_leases: number }>(
      `select count(*)::int live_leases from app.trigger_schedules
          where trigger_id=$1 and lease_token is not null
            and lease_expires_at>clock_timestamp()`,
      [triggerId],
    );
    expect(live.rows[0]?.live_leases).toBe(0);
  }, 60_000);

  it('cancels blocked acceptance and releases its committed schedule claim for recovery', async () => {
    if (racePool === undefined)
      throw new Error('race pool was not initialized');
    const workerConnectionString = schedule.worker.options.connectionString;
    if (workerConnectionString === undefined)
      throw new Error('worker connection string was not configured');
    const databasePath = new URL(workerConnectionString).pathname;
    const acceptanceApplicationName = `schedule-cancel-${randomUUID()}`;
    const workerUrl = scopedConnectionUrl(
      process.env.DATABASE_WORKER_URL ??
        'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo',
      databasePath,
    );
    const apiUrl = scopedConnectionUrl(
      process.env.DATABASE_API_URL ??
        'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo',
      databasePath,
      acceptanceApplicationName,
    );
    const adminUrl = scopedConnectionUrl(
      process.env.DATABASE_ADMIN_URL ??
        'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
      databasePath,
    );
    const control = new Pool({ connectionString: adminUrl, max: 2 });
    const blocker = await control.connect();
    const scanner = createScheduleTriggerScanner(
      parseDatabaseConfig({ connectionString: workerUrl, max: 1 }),
      BASELINE_COMPATIBILITY_EXPECTATION,
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
    );
    const controller = new AbortController();
    const cancellation = new Error('cancel blocked schedule acceptance');
    let blockerTransactionOpen = false;
    let recoveredClaim:
      Readonly<{ lease_token: string; trigger_id: string }> | undefined;
    try {
      await ownerQuery(
        `update app.trigger_schedules
            set next_fire_at=clock_timestamp()-interval '1 second',
                admission_deferred_until=null,health_status='healthy',
                last_error_code=null,lease_owner=null,lease_token=null,
                lease_acquired_at=null,lease_expires_at=null
          where trigger_id=$1`,
        [triggerId],
      );
      const durableBefore = await ownerQuery<{
        occurrences: number;
        runs: number;
      }>(
        `select
           (select count(*)::int from app.trigger_schedule_occurrences
             where trigger_id=$1) occurrences,
           (select count(*)::int from app.workflow_runs
             where workflow_id=$2 and trigger_type='schedule') runs`,
        [triggerId, schedule.workflowId],
      );

      await blocker.query('begin');
      blockerTransactionOpen = true;
      await blocker.query(
        `select singleton from app.node_compatibility_current
          where singleton for update`,
      );

      const scan = scanner.scanDue({
        checkpointFactory: schedule.checkpointFactory,
        leaseOwner: 'cancellation-recovery-scanner',
        leaseSeconds: 300,
        onTimeWindowSeconds: 300,
        limit: 1,
        signal: controller.signal,
      });
      const rejectedScan = expect(scan).rejects.toBe(cancellation);
      await waitForApplicationLock(control, acceptanceApplicationName);
      await expect(
        ownerQuery<{ lease_owner: string }>(
          `select lease_owner from app.trigger_schedules
            where trigger_id=$1 and lease_expires_at>clock_timestamp()`,
          [triggerId],
        ),
      ).resolves.toMatchObject({
        rows: [{ lease_owner: 'cancellation-recovery-scanner' }],
      });

      controller.abort(cancellation);
      await rejectedScan;

      await expect(
        ownerQuery(
          `select lease_owner,lease_token,lease_acquired_at,lease_expires_at
             from app.trigger_schedules where trigger_id=$1`,
          [triggerId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            lease_acquired_at: null,
            lease_expires_at: null,
            lease_owner: null,
            lease_token: null,
          },
        ],
      });
      await expect(
        ownerQuery<{
          occurrences: number;
          runs: number;
        }>(
          `select
             (select count(*)::int from app.trigger_schedule_occurrences
               where trigger_id=$1) occurrences,
             (select count(*)::int from app.workflow_runs
               where workflow_id=$2 and trigger_type='schedule') runs`,
          [triggerId, schedule.workflowId],
        ),
      ).resolves.toEqual(durableBefore);

      const recovered = await racePool.query<{
        lease_token: string;
        trigger_id: string;
      }>(
        'select trigger_id,lease_token from app.claim_due_trigger_schedules($1,1,30)',
        ['post-cancellation-recovery'],
      );
      recoveredClaim = recovered.rows[0];
      expect(recoveredClaim?.trigger_id).toBe(triggerId);
    } finally {
      if (recoveredClaim !== undefined)
        await racePool
          .query('select app.release_trigger_schedule_claim($1,$2)', [
            recoveredClaim.trigger_id,
            recoveredClaim.lease_token,
          ])
          .catch(() => undefined);
      if (blockerTransactionOpen)
        await blocker.query('rollback').catch(() => undefined);
      blocker.release();
      await Promise.allSettled([scanner.close(), control.end()]);
    }
  });
});
