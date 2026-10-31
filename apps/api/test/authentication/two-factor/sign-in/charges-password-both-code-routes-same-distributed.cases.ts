import { expect, it } from 'vitest';

import { expectProblem } from '../../../support/better-auth/real-api.support.js';
import { factorPassword } from '../../../support/better-auth/two-factor.js';

import type { createFactorAdmissionFixture } from './fixture.js';

export function registerChargesPasswordBothCodeRoutesSameDistributed(
  caseFixture: ReturnType<typeof createFactorAdmissionFixture>,
): void {
  const { api } = caseFixture;

  it('charges password and both code routes to the same client address budget', async () => {
    const remoteAddress = '198.51.100.77';
    expectProblem(
      await api.send('POST', '/v1/auth/sign-in/email', {
        remoteAddress,
        payload: { email: 'missing@example.test', password: factorPassword },
      }),
      401,
      'auth.unauthenticated',
    );
    for (let attempt = 0; attempt < 9; attempt++) {
      const path = attempt % 2 === 0 ? 'verify-totp' : 'verify-backup-code';
      expectProblem(
        await api.send('POST', `/v1/auth/two-factor/${path}`, {
          remoteAddress,
          payload: { code: 'invalid' },
        }),
        401,
        'auth.unauthenticated',
      );
    }
    for (const path of ['verify-totp', 'verify-backup-code']) {
      const reply = await api.send('POST', `/v1/auth/two-factor/${path}`, {
        remoteAddress,
        payload: { code: 'invalid' },
      });
      expectProblem(reply, 429, 'request.rate_limited');
      expect(Number(reply.headers['retry-after'])).toBeGreaterThan(0);
    }
  });
}
