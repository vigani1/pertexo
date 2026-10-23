import { expect, it } from 'vitest';

import { expectProblem } from '../../../support/better-auth/real-api.support.js';
import { factorPassword } from '../../../support/better-auth/two-factor.js';

import type { createFactorAdmissionFixture } from './fixture.js';

export function registerChargesPasswordBothCodeRoutesSameDistributed(
  caseFixture: ReturnType<typeof createFactorAdmissionFixture>,
): void {
  const { api } = caseFixture;

  it('charges password and both code routes to the same distributed origin budget', async () => {
    expectProblem(
      await api.send('POST', '/v1/auth/sign-in/email', {
        payload: { email: 'missing@example.test', password: factorPassword },
      }),
      401,
      'auth.unauthenticated',
    );
    for (let attempt = 0; attempt < 29; attempt++) {
      const path = attempt % 2 === 0 ? 'verify-totp' : 'verify-backup-code';
      expectProblem(
        await api.send('POST', `/v1/auth/two-factor/${path}`, {
          payload: { code: 'invalid' },
        }),
        401,
        'auth.unauthenticated',
      );
    }
    for (const path of ['verify-totp', 'verify-backup-code']) {
      const reply = await api.send('POST', `/v1/auth/two-factor/${path}`, {
        payload: { code: 'invalid' },
      });
      expectProblem(reply, 429, 'request.rate_limited');
      expect(Number(reply.headers['retry-after'])).toBeGreaterThan(0);
    }
  });
}
