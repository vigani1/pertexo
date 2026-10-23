import { ACCOUNT_SIGN_IN_METHOD_LIMIT } from '@pertexo/contracts';
import { randomUUID, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  OrganizationSignInCommands,
  authorizeCredentialSignIn,
  isAuthenticationSessionAllowed,
} from '../../../src/tenant-access/index.js';
import { useIdentityCommandDatabase } from '../command.support.js';
const db = useIdentityCommandDatabase('oidc_proof');
const key = () => randomUUID();
const digest = () => createHash('sha256').update(key()).digest();
async function setup(jitEnabled = false) {
  const owner = await db.user('Recovery owner'),
    workspaceId = await db.workspace(owner.id);
  const scope = { workspaceId, actorId: owner.id };
  const created = await db.federation().createOrganization({
    ...scope,
    name: 'Example organization',
    idempotencyKey: key(),
  });
  const domain = `${key()}.example.test`;
  const pending = await db.federation().createDomain({
    ...scope,
    domain,
    expectedRevision: 1,
    idempotencyKey: key(),
  });
  const domainId = pending.organization?.domains[0]?.id;
  if (domainId === undefined) throw new Error('Missing domain');
  const challenge = await db
    .federation()
    .domainChallenge({ ...scope, domainId });
  await db.federation().verifyDomain({
    ...scope,
    domainId,
    observedChallenge: challenge.challenge,
    expectedRevision: 2,
    idempotencyKey: key(),
  });
  const configured = await db.federation().createProvider({
    ...scope,
    name: 'Example OIDC',
    issuer: 'https://idp.example.test/tenant',
    configuration: {
      clientId: 'client',
      emailClaim: 'email',
      nameClaim: 'name',
      jitEnabled,
    },
    enabled: true,
    sealSecret: (id) => ({ ciphertext: 'sealed-private', provider: id }),
    secretFingerprint: 'purpose-bound-test-fingerprint',
    expectedRevision: 3,
    idempotencyKey: key(),
  });
  const providerId = configured.organization?.providers[0]?.id,
    organizationId = created.organization?.id;
  if (providerId === undefined || organizationId === undefined)
    throw new Error('Missing provider');
  const commands = new OrganizationSignInCommands({
    pool: db.authenticationPool(),
    sessionTtlSeconds: 3600,
  });
  return {
    owner,
    scope,
    domain,
    domainId,
    providerId,
    organizationId,
    commands,
  };
}
async function begin(
  fixture: Awaited<ReturnType<typeof setup>>,
  purpose: 'sign_in' | 'test' = 'sign_in',
  ownerSessionId?: string,
) {
  const { commands, domain, providerId, domainId, owner } = fixture;
  const material = await commands.provider(providerId, domain);
  if (material === undefined) throw new Error('Missing provider material');
  const attempt = {
    id: key(),
    providerId,
    providerRevision: material.provider.revision,
    domainId,
    purpose,
    stateDigest: digest(),
    browserDigest: digest(),
    returnPath: '/workspaces',
    ...(purpose === 'test'
      ? { ownerUserId: owner.id, ownerSessionId: ownerSessionId ?? '' }
      : {}),
  };
  await commands.start(attempt);
  return { ...attempt, attemptId: attempt.id };
}
async function ownerSession(fixture: Awaited<ReturnType<typeof setup>>) {
  const token = await db.sessions(fixture.owner.id);
  const [session] = await db.asAdmin<{ id: string }>(
    'select id from app.auth_sessions where token=$1',
    [token],
  );
  if (session === undefined) throw new Error('Missing owner session');
  return session.id;
}
async function verifiedUser(domain: string, name = 'Member') {
  const user = await db.user(name);
  const email = `${key()}@${domain}`;
  await db.asAdmin(
    'update app.users set email=$2,email_verified=true where id=$1',
    [user.id, email],
  );
  return { ...user, email };
}
async function sessionId(token: string) {
  const [session] = await db.asAdmin<{ id: string }>(
    'select id from app.auth_sessions where token=$1',
    [token],
  );
  if (session === undefined) throw new Error('Missing session');
  return session.id;
}
describe('durable organization sign-in', () => {
  registerBoundsAttachedMethodsRollsBack();

  registerNeverTakesOverUnverifiedExisting();
});

function registerBoundsAttachedMethodsRollsBack(): void {
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

function registerNeverTakesOverUnverifiedExisting(): void {
  it('never takes over an unverified existing email', async () => {
    const fixture = await setup(true),
      user = await verifiedUser(fixture.domain);
    await db.asAdmin('update app.users set email_verified=false where id=$1', [
      user.id,
    ]);
    await expect(
      fixture.commands.complete({
        ...(await begin(fixture)),
        identity: {
          subject: 'blocked-subject',
          email: user.email,
          displayName: 'Member',
        },
      }),
    ).resolves.toEqual({ kind: 'failed' });
    await expect(
      db.asAdmin(
        'select id from app.auth_accounts where user_id=$1 and provider_id=$2',
        [user.id, fixture.providerId],
      ),
    ).resolves.toHaveLength(0);
  });

  it.each(['suspended', 'removed'] as const)(
    'skips a %s membership without refusing sign-in or grants in another linked workspace',
    async (status) => {
      const fixture = await setup(true),
        user = await verifiedUser(fixture.domain),
        targetWorkspaceId = await db.workspace(fixture.owner.id);
      const settings = await db.federation().settings(fixture.scope);
      if (settings.organization === null)
        throw new Error('Missing organization');
      await db.federation().linkWorkspace({
        ...fixture.scope,
        targetWorkspaceId,
        defaultRole: 'builder',
        expectedRevision: settings.organization.revision,
        idempotencyKey: key(),
      });
      await db.member(fixture.scope.workspaceId, user.id, 'operator');
      await db.asAdmin(
        'update app.workspace_memberships set status=$3 where workspace_id=$1 and user_id=$2',
        [fixture.scope.workspaceId, user.id, status],
      );
      const previousMembership = await db.asAdmin(
        'select * from app.workspace_memberships where workspace_id=$1 and user_id=$2',
        [fixture.scope.workspaceId, user.id],
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await fixture.commands.complete({
          ...(await begin(fixture)),
          identity: {
            subject: 'stable-subject',
            email: user.email,
            displayName: 'Member',
          },
        });
        if (result.kind !== 'signed_in') throw new Error('Sign-in failed');
        await expect(
          isAuthenticationSessionAllowed(
            db.authenticationPool(),
            await sessionId(result.token),
          ),
        ).resolves.toBe(true);
      }
      await expect(
        db.asAdmin(
          'select * from app.workspace_memberships where workspace_id=$1 and user_id=$2',
          [fixture.scope.workspaceId, user.id],
        ),
      ).resolves.toEqual(previousMembership);
      await expect(
        db.asAdmin(
          'select role,status,role_revision from app.workspace_memberships where workspace_id=$1 and user_id=$2',
          [targetWorkspaceId, user.id],
        ),
      ).resolves.toEqual([
        { role: 'builder', status: 'active', role_revision: 1 },
      ]);
      await expect(
        db.asAdmin(
          'select user_id from app.auth_accounts where user_id=$1 and provider_id=$2',
          [user.id, fixture.providerId],
        ),
      ).resolves.toEqual([{ user_id: user.id }]);
      await expect(
        db.asAdmin(
          "select workspace_id,actor_user_id,target_type,target_id,metadata from app.audit_events where workspace_id=any($1::uuid[]) and action='workspace.member_added' and target_id=$2",
          [[fixture.scope.workspaceId, targetWorkspaceId], user.id],
        ),
      ).resolves.toEqual([
        {
          workspace_id: targetWorkspaceId,
          actor_user_id: user.id,
          target_type: 'workspace_member',
          target_id: user.id,
          metadata: {
            source: 'jit',
            organizationId: fixture.organizationId,
            role: 'builder',
            status: 'active',
            roleRevision: 1,
          },
        },
      ]);
    },
  );

  it('consumes one callback across two instances and refuses replay, wrong browser, wrong domain and stale provider revisions', async () => {
    const fixture = await setup(true),
      attempt = await begin(fixture);
    const identity = {
      subject: 'race-subject',
      email: `race@${fixture.domain}`,
      displayName: 'Race',
    };
    await expect(
      fixture.commands.complete({
        ...attempt,
        browserDigest: digest(),
        identity,
      }),
    ).resolves.toEqual({ kind: 'failed' });
    await expect(
      fixture.commands.complete({
        ...attempt,
        identity: { ...identity, email: 'wrong@elsewhere.test' },
      }),
    ).resolves.toEqual({ kind: 'failed' });
    const replica = new OrganizationSignInCommands({
      pool: db.authenticationPool(1),
      sessionTtlSeconds: 3600,
    });
    const results = await Promise.all([
      fixture.commands.complete({ ...attempt, identity }),
      replica.complete({ ...attempt, identity }),
    ]);
    expect(
      results.filter((result) => result.kind === 'signed_in'),
    ).toHaveLength(1);
    const stale = await begin(fixture);
    await db.asAdmin(
      'update app.auth_providers set revision=revision+1 where id=$1',
      [fixture.providerId],
    );
    await expect(
      fixture.commands.complete({ ...stale, identity }),
    ).resolves.toEqual({ kind: 'failed' });
  });

  it('enforces current SSO on old sessions and reserves password recovery for the owner of that organization', async () => {
    const fixture = await setup();
    const member = await verifiedUser(fixture.domain),
      unrelatedOwner = await verifiedUser(fixture.domain, 'Unrelated owner');
    await db.workspace(unrelatedOwner.id);
    const memberToken = await db.sessions(member.id);
    const ownerEmail = `owner@${fixture.domain}`;
    await db.asAdmin(
      'update app.users set email=$2,email_verified=true where id=$1',
      [fixture.owner.id, ownerEmail],
    );
    await db.asAdmin(
      "insert into app.auth_accounts(id,user_id,provider_id,account_id,password) values($1,$2::uuid,'credential',$3,'password-hash')",
      [key(), fixture.owner.id, fixture.owner.id],
    );
    const source = await ownerSession(fixture);
    await fixture.commands.complete({
      ...(await begin(fixture, 'test', source)),
      identity: {
        subject: 'test-owner',
        email: ownerEmail,
        displayName: 'Owner',
      },
      ownerSessionId: source,
    });
    await db.federation().configureEnforcement({
      ...fixture.scope,
      domainId: fixture.domainId,
      required: true,
      expectedRevision: 4,
      idempotencyKey: key(),
    });
    await expect(
      isAuthenticationSessionAllowed(
        db.authenticationPool(),
        await db
          .asAdmin<{ id: string }>(
            'select id from app.auth_sessions where token=$1',
            [memberToken],
          )
          .then((rows) => rows[0]?.id ?? key()),
      ),
    ).resolves.toBe(false);
    await expect(
      authorizeCredentialSignIn(db.authenticationPool(), member.id),
    ).resolves.toBe('sso_required');
    await expect(
      authorizeCredentialSignIn(db.authenticationPool(), unrelatedOwner.id),
    ).resolves.toBe('sso_required');
    await expect(
      authorizeCredentialSignIn(db.authenticationPool(), fixture.owner.id),
    ).resolves.toBe('recovery');
    await expect(
      db.asAdmin(
        "select id from app.audit_events where workspace_id=$1 and action='identity.recovery_authorized'",
        [fixture.scope.workspaceId],
      ),
    ).resolves.toHaveLength(1);
    const enforced = await fixture.commands.complete({
      ...(await begin(fixture)),
      identity: {
        subject: 'member-subject',
        email: member.email,
        displayName: 'Member',
      },
    });
    expect(enforced.kind).toBe('signed_in');
  });
}
