import { ACCOUNT_SIGN_IN_METHOD_LIMIT } from '@pertexo/contracts';

import { expect, it } from 'vitest';
import { isAuthenticationSessionAllowed } from '../../../../src/identity/index.js';

import {
  db,
  key,
  setup,
  begin,
  ownerSession,
  verifiedUser,
  sessionId,
} from './fixture.js';

export function registerBoundsAttachedMethodsRollsBack(): void {
  it('bounds attached methods and rolls back a refused attachment before JIT or session revocation', async () => {
    const fixture = await setup(true),
      member = await verifiedUser(fixture.domain);
    await db.asAdmin(
      "insert into app.auth_accounts(id,user_id,provider_id,account_id) select gen_random_uuid(),$1::uuid,'existing-'||n::text,n::text from generate_series(1,$2::int) n",
      [member.id, ACCOUNT_SIGN_IN_METHOD_LIMIT],
    );
    const existingToken = await db.sessions(member.id);
    const attempt = await begin(fixture);
    await expect(
      fixture.commands.complete({
        ...attempt,
        identity: {
          subject: 'one-too-many',
          email: member.email,
          displayName: 'Member',
        },
      }),
    ).resolves.toEqual({ kind: 'failed' });
    expect(
      await db.asAdmin('select id from app.auth_accounts where user_id=$1', [
        member.id,
      ]),
    ).toHaveLength(ACCOUNT_SIGN_IN_METHOD_LIMIT);
    expect(
      await db.asAdmin('select id from app.auth_sessions where token=$1', [
        existingToken,
      ]),
    ).toHaveLength(1);
    expect(
      await db.asAdmin(
        'select user_id from app.workspace_memberships where workspace_id=$1 and user_id=$2',
        [fixture.scope.workspaceId, member.id],
      ),
    ).toHaveLength(0);
    expect(
      await db.asAdmin(
        'select consumed_at from app.auth_federation_attempts where id=$1',
        [attempt.id],
      ),
    ).toEqual([{ consumed_at: null }]);
  });

  it('keeps owner tests separate from identities, membership grants and sessions', async () => {
    const fixture = await setup(true),
      source = await ownerSession(fixture);
    const attempt = await begin(fixture, 'test', source);
    await expect(
      fixture.commands.complete({
        ...attempt,
        identity: {
          subject: 'not-linked',
          email: `test@${fixture.domain}`,
          displayName: 'Test identity',
        },
        ownerSessionId: source,
      }),
    ).resolves.toEqual({ kind: 'tested', returnPath: '/workspaces' });
    await expect(
      db.asAdmin('select id from app.users where email=$1', [
        `test@${fixture.domain}`,
      ]),
    ).resolves.toHaveLength(0);
    await expect(db.liveSessions(fixture.owner.id)).resolves.toBe(1);
    await expect(
      db.asAdmin(
        'select provider_id from app.auth_provider_checks where organization_id=$1',
        [fixture.organizationId],
      ),
    ).resolves.toEqual([{ provider_id: fixture.providerId }]);
    await expect(
      fixture.commands.complete({
        ...attempt,
        identity: {
          subject: 'not-linked',
          email: `test@${fixture.domain}`,
          displayName: 'Test identity',
        },
        ownerSessionId: source,
      }),
    ).resolves.toEqual({ kind: 'failed' });
  });

  it('requires the initiating current owner session to complete a readiness test', async () => {
    const fixture = await setup(),
      source = await ownerSession(fixture);
    const attempt = await begin(fixture, 'test', source);
    await expect(
      fixture.commands.complete({
        ...attempt,
        identity: {
          subject: 'subject',
          email: `test@${fixture.domain}`,
          displayName: 'Test',
        },
        ownerSessionId: key(),
      }),
    ).resolves.toEqual({ kind: 'failed' });
    await db.asAdmin('delete from app.auth_sessions where id=$1', [source]);
    await expect(
      fixture.commands.complete({
        ...attempt,
        identity: {
          subject: 'subject',
          email: `test@${fixture.domain}`,
          displayName: 'Test',
        },
        ownerSessionId: source,
      }),
    ).resolves.toEqual({ kind: 'failed' });
    await expect(
      db.asAdmin(
        'select provider_id from app.auth_provider_checks where organization_id=$1',
        [fixture.organizationId],
      ),
    ).resolves.toHaveLength(0);
  });

  it('does not create an account when JIT is off and the identity is new', async () => {
    const fixture = await setup(),
      attempt = await begin(fixture);
    const email = `new@${fixture.domain}`;
    await expect(
      fixture.commands.complete({
        ...attempt,
        identity: { subject: 'new-subject', email, displayName: 'New member' },
      }),
    ).resolves.toEqual({ kind: 'failed' });
    await expect(
      db.asAdmin('select id from app.users where email=$1', [email]),
    ).resolves.toHaveLength(0);
  });

  it('grants only the configured non-owner default, saves immutable provider identity and records the session proof', async () => {
    const fixture = await setup(true),
      attempt = await begin(fixture);
    const email = `new@${fixture.domain}`;
    const result = await fixture.commands.complete({
      ...attempt,
      identity: { subject: 'new-subject', email, displayName: 'New member' },
    });
    if (result.kind !== 'signed_in') throw new Error('Sign-in failed');
    const [user] = await db.asAdmin<{ id: string }>(
      'select id from app.users where email=$1',
      [email],
    );
    if (user === undefined) throw new Error('Missing user');
    await expect(
      db.asAdmin(
        'select role,status from app.workspace_memberships where workspace_id=$1 and user_id=$2',
        [fixture.scope.workspaceId, user.id],
      ),
    ).resolves.toEqual([{ role: 'viewer', status: 'active' }]);
    await expect(
      db.asAdmin(
        'select provider_id,account_id,access_token,refresh_token,id_token from app.auth_accounts where user_id=$1',
        [user.id],
      ),
    ).resolves.toEqual([
      {
        provider_id: fixture.providerId,
        account_id: 'new-subject',
        access_token: null,
        refresh_token: null,
        id_token: null,
      },
    ]);
    await expect(
      isAuthenticationSessionAllowed(
        db.authenticationPool(),
        await sessionId(result.token),
      ),
    ).resolves.toBe(true);
    await expect(
      db.asAdmin(
        'select authentication_method,federation_provider_id,federation_provider_revision from app.auth_sessions where token=$1',
        [result.token],
      ),
    ).resolves.toEqual([
      {
        authentication_method: 'organization',
        federation_provider_id: fixture.providerId,
        federation_provider_revision: 1,
      },
    ]);
  });

  it('links verified existing accounts and keeps a stable subject across provider email changes', async () => {
    const fixture = await setup(),
      user = await verifiedUser(fixture.domain);
    await db.sessions(user.id);
    const first = await fixture.commands.complete({
      ...(await begin(fixture)),
      identity: {
        subject: 'stable-subject',
        email: user.email,
        displayName: 'Member',
      },
    });
    expect(first.kind).toBe('signed_in');
    await expect(db.liveSessions(user.id)).resolves.toBe(1);
    const next = await fixture.commands.complete({
      ...(await begin(fixture)),
      identity: {
        subject: 'stable-subject',
        email: `renamed@${fixture.domain}`,
        displayName: 'Renamed',
      },
    });
    expect(next.kind).toBe('signed_in');
    await expect(
      db.asAdmin('select email from app.users where id=$1', [user.id]),
    ).resolves.toEqual([{ email: user.email }]);
  });
}
