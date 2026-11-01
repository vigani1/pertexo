import { expect, it } from 'vitest';
import {
  OrganizationSignInCommands,
  authorizeCredentialSignIn,
  isAuthenticationSessionAllowed,
} from '../../../../src/identity/index.js';

import {
  db,
  key,
  digest,
  setup,
  begin,
  ownerSession,
  verifiedUser,
  sessionId,
} from './fixture.js';

export function registerNeverTakesOverUnverifiedExisting(): void {
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
