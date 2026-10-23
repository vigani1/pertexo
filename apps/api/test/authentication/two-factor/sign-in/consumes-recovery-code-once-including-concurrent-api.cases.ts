import { expect, it } from 'vitest';

import {
  browserFrom,
  expectProblem,
} from '../../../support/better-auth/real-api.support.js';

import type { createRecoveryFixture } from './fixture.js';

export function registerConsumesRecoveryCodeOnceIncludingConcurrentAPI(
  caseFixture: ReturnType<typeof createRecoveryFixture>,
): void {
  const { person, challenge, verify, api } = caseFixture;

  it('consumes a recovery code once, including concurrent API requests, and reports only the unused count', async () => {
    const user = await person();
    const code = user.backupCodes[0];
    if (code === undefined) throw new Error('Recovery code missing');
    const cookies = await Promise.all([
      challenge(user.email),
      challenge(user.email),
    ]);
    const replies = await Promise.all(
      cookies.map((cookie) => verify(cookie, code, true)),
    );
    expect(replies.filter((reply) => reply.statusCode === 200)).toHaveLength(1);
    const accepted = replies.find((reply) => reply.statusCode === 200);
    if (accepted === undefined) throw new Error('Recovery sign-in missing');
    expect(accepted.json()).not.toHaveProperty('token');
    const browser = browserFrom(accepted);
    const read = await api.send('GET', '/v1/auth/account-security', {
      browser,
    });
    expect(read.json()).toMatchObject({
      twoFactor: { enabled: true, recoveryCodesRemaining: 9 },
    });
    expectProblem(
      await verify(await challenge(user.email), code, true),
      401,
      'auth.unauthenticated',
    );
  });
}
