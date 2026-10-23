import { expect, it } from 'vitest';

import { expectProblem } from '../../../support/better-auth/real-api.support.js';
import { authenticatorCode } from '../../../support/better-auth/two-factor.js';

import type { createFactorLockoutFixture } from './fixture.js';

export function registerEnforcesPluginAccountLockoutResetsExpiredFailure(
  caseFixture: ReturnType<typeof createFactorLockoutFixture>,
): void {
  const { person, verify, challenge, backup, api } = caseFixture;

  it('enforces the plugin account lockout and resets expired failure counters after a successful code', async () => {
    const user = await person();
    for (let attempt = 0; attempt < 10; attempt++)
      expectProblem(
        await verify(await challenge(user.email), 'invalid', backup),
        401,
        'auth.unauthenticated',
      );
    expectProblem(
      await verify(
        await challenge(user.email),
        backup ? (user.backupCodes[0] ?? '') : authenticatorCode(user.totpURI),
        backup,
      ),
      429,
      'auth.two_factor_locked',
    );
    const locked = await api.database().query<{
      failed_verification_count: number;
      locked_until: Date | null;
    }>('select failed_verification_count,locked_until from app.auth_two_factors where user_id=(select id from app.users where email=$1)', [user.email]);
    expect(locked.rows[0]?.failed_verification_count).toBe(10);
    expect(locked.rows[0]?.locked_until?.getTime()).toBeGreaterThan(Date.now());
    await api
      .database()
      .query(
        "update app.auth_two_factors set locked_until=clock_timestamp()-interval '1 second' where user_id=(select id from app.users where email=$1)",
        [user.email],
      );
    expect(
      (
        await verify(
          await challenge(user.email),
          backup
            ? (user.backupCodes[0] ?? '')
            : authenticatorCode(user.totpURI),
          backup,
        )
      ).statusCode,
    ).toBe(200);
    const state = await api
      .database()
      .query(
        'select failed_verification_count,locked_until from app.auth_two_factors where user_id=(select id from app.users where email=$1)',
        [user.email],
      );
    expect(state.rows).toEqual([
      { failed_verification_count: 0, locked_until: null },
    ]);
  });
}
