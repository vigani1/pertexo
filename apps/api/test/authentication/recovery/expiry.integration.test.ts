import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { betterAuthIntegrationEnabled } from '../../support/better-auth/real-api.support.js';
import { useRecoveryApi, waitForBlocked } from './fixture.js';

describe.runIf(betterAuthIntegrationEnabled)('reset database deadlines', () => {
  const api = useRecoveryApi();
  it('refuses a proof that expires during the actual user lock wait without changing security state', async () => {
    const person = await api.account(),
      token = await api.link(person.email);
    const before = await api.state(person.userId);
    const observer = new Pool({ ...api.database().options, max: 1 });
    const lock = await api.database().connect();
    let pending: ReturnType<typeof api.reset> | undefined;
    try {
      await lock.query('begin');
      const {
        rows: [row],
      } = await lock.query<{ pid: number }>('select pg_backend_pid() pid');
      if (row === undefined) throw new Error('No lock backend');
      await lock.query('select id from app.users where id=$1 for update', [
        person.userId,
      ]);
      pending = api.reset(token);
      await waitForBlocked(observer, row.pid, 1);
      expect(
        (
          await observer.query<{ fresh: boolean }>(
            'select expires_at>clock_timestamp() fresh from app.auth_verifications where identifier=$1',
            [`reset-password:${token}`],
          )
        ).rows,
      ).toEqual([{ fresh: true }]);
      // Establish the short deadline only once the request is actually queued, so password hashing cannot consume the proof's test lifetime.
      await observer.query(
        "update app.auth_verifications set expires_at=clock_timestamp()+interval '100 milliseconds' where identifier=$1",
        [`reset-password:${token}`],
      );

      await expect
        .poll(
          async () =>
            (
              await observer.query<{ expired: boolean }>(
                'select expires_at<clock_timestamp() expired from app.auth_verifications where identifier=$1',
                [`reset-password:${token}`],
              )
            ).rows[0]?.expired,
          { timeout: 5_000 },
        )
        .toBe(true);
      await lock.query('commit');
    } finally {
      await lock.query('rollback');
      lock.release();
      await observer.end();
    }
    expect((await pending).statusCode).toBe(400);
    expect(await api.state(person.userId)).toEqual(before);
  });
  it.each([
    {
      name: 'slow',
      skew: -86_400_000,
      deadline: "clock_timestamp()-interval '1 minute'",
      status: 400,
    },
    {
      name: 'fast',
      skew: 86_400_000,
      deadline: "clock_timestamp()+interval '1 hour'",
      status: 200,
    },
  ])(
    'uses database expiry with a $name API clock',
    async ({ skew, deadline, status }) => {
      const person = await api.account(),
        token = await api.link(person.email);
      await api
        .database()
        .query(
          `update app.auth_verifications set expires_at=${deadline} where identifier=$1`,
          [`reset-password:${token}`],
        );
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now + skew);
      try {
        const reply = await api.reset(token);
        expect(reply.statusCode, reply.payload).toBe(status);
      } finally {
        clock.mockRestore();
      }
    },
  );
});
