import { Pool } from 'pg';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

      await Promise.all(
        returnedClaims.map((claim) =>
          pool.query('select app.release_trigger_schedule_claim($1,$2)', [
            claim.trigger_id,
            claim.lease_token,
          ]),
        ),
      );
    }

    const live = await ownerQuery<{ live_leases: number }>(
      `select count(*)::int live_leases from app.trigger_schedules
          where trigger_id=$1 and lease_token is not null
            and lease_expires_at>clock_timestamp()`,
      [triggerId],
    );
    expect(live.rows[0]?.live_leases).toBe(0);
  }, 60_000);
});
