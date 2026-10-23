import { expect, it } from 'vitest';
import { accountSecurityResponseSchema } from '@pertexo/contracts';
import {
  browserFrom,
  expectProblem,
} from '../../../support/better-auth/real-api.support.js';
import { authenticatorCode } from '../../../support/better-auth/two-factor.js';

import type { createAuthenticatorFixture } from './fixture.js';

export function registerRequiresCodeRefusesWrongCodeCreatesFresh(
  caseFixture: ReturnType<typeof createAuthenticatorFixture>,
): void {
  const { person, challenge, api, verify } = caseFixture;

  it('requires a code, refuses a wrong code, creates a fresh token-free session and consumes the challenge once', async () => {
    const user = await person();
    const cookie = await challenge(user.email);
    expectProblem(
      await api.send('GET', '/v1/users/me', { headers: { cookie } }),
      401,
      'auth.unauthenticated',
    );
    expectProblem(await verify(cookie, 'invalid'), 401, 'auth.unauthenticated');
    const accepted = await verify(cookie, authenticatorCode(user.totpURI));
    expect(accepted.statusCode, accepted.payload).toBe(200);
    expect(accepted.json()).not.toHaveProperty('token');
    const browser = browserFrom(accepted);
    expect(
      (await api.send('GET', '/v1/users/me', { browser })).statusCode,
    ).toBe(200);
    const evidence = await api
      .identity()
      .betterAuth.sessions.evidence(browser.session);
    expect(evidence).toBeDefined();
    expect(Date.now() - (evidence?.signedInAt.getTime() ?? 0)).toBeLessThan(
      5 * 60_000,
    );
    expectProblem(
      await verify(cookie, authenticatorCode(user.totpURI)),
      401,
      'auth.unauthenticated',
    );
    const read = await api.send('GET', '/v1/auth/account-security', {
      browser,
    });
    expect(accountSecurityResponseSchema.parse(read.json()).twoFactor).toEqual({
      enabled: true,
      recoveryCodesRemaining: 10,
    });
    expect(read.payload).not.toContain(user.backupCodes[0]);
    expect(read.payload).not.toContain(
      new URL(user.totpURI).searchParams.get('secret'),
    );
    const stored = await api.database().query<{
      secret: string;
      backup_codes: string;
      failed_verification_count: number;
      locked_until: Date | null;
    }>('select factor.secret,factor.backup_codes,factor.failed_verification_count,factor.locked_until from app.auth_two_factors factor join app.users users on users.id=factor.user_id where users.email=$1', [user.email]);
    expect(stored.rows[0]).toMatchObject({
      failed_verification_count: 0,
      locked_until: null,
    });
    expect(stored.rows[0]?.backup_codes).not.toContain(user.backupCodes[0]);
    expect(stored.rows[0]?.secret).not.toContain(
      new URL(user.totpURI).searchParams.get('secret'),
    );
  });
}
