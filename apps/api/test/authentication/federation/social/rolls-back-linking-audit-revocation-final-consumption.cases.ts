import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

import type { createSocialSignInFixture } from './fixture.js';

export function registerRollsBackLinkingAuditRevocationFinalConsumption(
  caseFixture: ReturnType<typeof createSocialSignInFixture>,
): void {
  const { identity, api, userId, start, finish } = caseFixture;

  it('rolls back linking, audit and revocation when final consumption fails', async () => {
    const proof = identity();
    const email = proof.email ?? '';
    await api.signUp(email, '/workspaces');
    const old = await api.signIn(email);
    const id = await userId(email);
    const journey = await start(proof);
    await api
      .database()
      .query(
        'alter table app.auth_sign_in_attempts add constraint fixture_consumption_fails check(consumed_at is null) not valid',
      );
    let response: Awaited<ReturnType<typeof finish>>;
    try {
      response = await finish(journey);
    } finally {
      await api
        .database()
        .query(
          'alter table app.auth_sign_in_attempts drop constraint fixture_consumption_fails',
        );
    }
    expect(response.headers.location).toContain('/login?socialError=true');
    expect(
      (await api.send('GET', '/v1/users/me', { browser: old })).statusCode,
    ).toBe(200);
    expect(
      (
        await api
          .database()
          .query(
            "select count(*)::int n from app.auth_accounts where user_id=$1 and provider_id='google'",
            [id],
          )
      ).rows[0],
    ).toEqual({ n: 0 });
    expect(
      (
        await api
          .database()
          .query(
            "select count(*)::int n from app.identity_security_audit_facts where user_id=$1 and event_type in ('method.linked','session.signed_in')",
            [id],
          )
      ).rows[0],
    ).toEqual({ n: 0 });
    expect(
      (
        await api
          .database()
          .query(
            'select consumed_at from app.auth_sign_in_attempts where state_digest=$1',
            [createHash('sha256').update(journey.state).digest()],
          )
      ).rows[0],
    ).toEqual({ consumed_at: null });
  });
}
