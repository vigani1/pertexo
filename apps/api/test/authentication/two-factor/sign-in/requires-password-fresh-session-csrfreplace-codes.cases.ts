import { expect, it } from 'vitest';

import {
  browserFrom,
  expectProblem,
} from '../../../support/better-auth/real-api.support.js';
import {
  authenticatorCode,
  factorPassword,
} from '../../../support/better-auth/two-factor.js';

import type { createFactorManagementFixture } from './fixture.js';

export function registerRequiresPasswordFreshSessionCSRFReplaceCodes(
  caseFixture: ReturnType<typeof createFactorManagementFixture>,
): void {
  const { person, verify, challenge, api } = caseFixture;

  it('requires password, fresh session and CSRF to replace codes or disable, and keeps other sessions signed in', async () => {
    const user = await person();
    const other = browserFrom(
      await verify(
        await challenge(user.email),
        authenticatorCode(user.totpURI),
      ),
    );
    for (const path of ['disable', 'generate-backup-codes']) {
      expectProblem(
        await api.send('POST', `/v1/auth/two-factor/${path}`, {
          browser: user.browser,
          payload: { password: 'wrong-password' },
        }),
        400,
        'request.invalid',
      );
      expectProblem(
        await api.send('POST', `/v1/auth/two-factor/${path}`, {
          headers: { cookie: user.browser.cookie },
          payload: { password: factorPassword },
        }),
        403,
        'auth.forbidden',
      );
    }
    const generated = await api.send(
      'POST',
      '/v1/auth/two-factor/generate-backup-codes',
      { browser: user.browser, payload: { password: factorPassword } },
    );
    expect(generated.statusCode).toBe(200);
    const codes = generated.json<{ backupCodes: string[] }>().backupCodes;
    expect(codes).toHaveLength(10);
    expectProblem(
      await verify(
        await challenge(user.email),
        user.backupCodes[0] ?? '',
        true,
      ),
      401,
      'auth.unauthenticated',
    );
    expect(
      (await verify(await challenge(user.email), codes[0] ?? '', true))
        .statusCode,
    ).toBe(200);
    await api
      .database()
      .query(
        "update app.auth_sessions set created_at=clock_timestamp()-interval '6 minutes' where token=split_part($1,'.',1)",
        [decodeURIComponent(user.browser.session)],
      );
    for (const path of [
      'enable',
      'disable',
      'get-totp-uri',
      'generate-backup-codes',
    ])
      expectProblem(
        await api.send('POST', `/v1/auth/two-factor/${path}`, {
          browser: user.browser,
          payload: { password: factorPassword },
        }),
        403,
        'auth.forbidden',
      );
    const disabled = await api.send('POST', '/v1/auth/two-factor/disable', {
      browser: other,
      payload: { password: factorPassword },
    });
    expect(disabled.statusCode, disabled.payload).toBe(200);
    expect(
      (await api.send('GET', '/v1/users/me', { browser: user.browser }))
        .statusCode,
    ).toBe(200);
    const read = await api.send('GET', '/v1/auth/account-security', {
      browser: browserFrom(disabled),
    });
    expect(read.json()).toMatchObject({
      twoFactor: { enabled: false, recoveryCodesRemaining: null },
    });
    expect((await api.signIn(user.email)).session).toBeTruthy();
  });
}
