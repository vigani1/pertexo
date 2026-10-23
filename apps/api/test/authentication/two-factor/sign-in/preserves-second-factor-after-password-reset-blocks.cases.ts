import { expect, it } from 'vitest';

import { expectProblem } from '../../../support/better-auth/real-api.support.js';
import { authenticatorCode } from '../../../support/better-auth/two-factor.js';

import type { createFactorResetFixture } from './fixture.js';

export function registerPreservesSecondFactorAfterPasswordResetBlocks(
  caseFixture: ReturnType<typeof createFactorResetFixture>,
): void {
  const { person, api, challenge, verify } = caseFixture;

  it('preserves the second factor after a password reset and blocks emailed codes and remembered devices', async () => {
    const user = await person();
    for (const path of ['send-otp', 'verify-otp'])
      expectProblem(
        await api.send('POST', `/v1/auth/two-factor/${path}`, {
          browser: user.browser,
          payload: { code: '123456' },
        }),
        404,
        'resource.not_found',
      );
    const cookie = await challenge(user.email);
    expectProblem(
      await api.send('POST', '/v1/auth/two-factor/verify-totp', {
        headers: { cookie },
        payload: { code: authenticatorCode(user.totpURI), trustDevice: true },
      }),
      400,
      'request.invalid',
    );
    const requested = await api.send(
      'POST',
      '/v1/auth/request-password-reset',
      { payload: { email: user.email, redirectTo: '/reset-password' } },
    );
    expect(requested.statusCode).toBe(200);
    const link = api.mailedLink(user.email, 'password_reset');
    const password = 'a different long integration password';
    const reset = await api.send(
      'POST',
      '/v1/auth/account-security/password/reset',
      {
        payload: {
          token: link.pathname.split('/').at(-1),
          newPassword: password,
        },
      },
    );
    expect(reset.statusCode, reset.payload).toBe(200);
    expect(
      (
        await verify(
          await challenge(user.email, password),
          authenticatorCode(user.totpURI),
        )
      ).statusCode,
    ).toBe(200);
  });
}
