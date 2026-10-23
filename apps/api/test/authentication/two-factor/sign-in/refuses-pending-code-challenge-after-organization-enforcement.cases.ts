import { expect, it } from 'vitest';

import {
  browserFrom,
  expectProblem,
} from '../../../support/better-auth/real-api.support.js';
import {
  authenticatorCode,
  enrollFactor,
} from '../../../support/better-auth/two-factor.js';

import type { createFactorOrganizationFixture } from './fixture.js';

export function registerRefusesPendingCodeChallengeAfterOrganizationEnforcement(
  caseFixture: ReturnType<typeof createFactorOrganizationFixture>,
): void {
  const { api, challenge, verify } = caseFixture;

  it('refuses a pending code challenge after organization enforcement changes and still permits organization sign-in', async () => {
    const setup = await api.setup();
    await api.ready(setup);
    const email = `member@${setup.domain}`;
    await api.signUp(email, '/workspaces');
    const user = await enrollFactor(api, await api.signIn(email));
    const cookies = await Promise.all([challenge(email), challenge(email)]);
    await api.enforce(setup);
    for (const [index, cookie] of cookies.entries()) {
      const reply = await verify(
        cookie,
        index === 0
          ? authenticatorCode(user.totpURI)
          : (user.backupCodes[0] ?? ''),
        index === 1,
      );
      expectProblem(reply, 409, 'auth.conflict');
      expect(reply.headers['set-cookie'] ?? []).not.toContainEqual(
        expect.stringMatching(/^pertexo_session=[^;]/u),
      );
    }
    const session = await api.finish(await api.start(setup, api.person(email)));
    expect(session.statusCode).toBe(302);
    expect(
      (
        await api.send('GET', '/v1/users/me', {
          browser: browserFrom(session),
        })
      ).statusCode,
    ).toBe(200);
  });
}
