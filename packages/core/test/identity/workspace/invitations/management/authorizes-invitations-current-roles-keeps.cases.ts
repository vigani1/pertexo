import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import { expect, it } from 'vitest';
import { workspaceMemberships } from '@pertexo/database/testing';

import {
  identityDatabase,
  tenantDatabase,
  ownerUserId,
  testSealedToken,
  invitationTokenDigest,
  invitationCreateCommand,
} from '../../fixture.js';

export function registerAuthorizesInvitationsCurrentRolesKeeps(): void {
  it('authorizes invitations from current roles and keeps workspace rows isolated', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation authority',
        slug: `invite-authority-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const otherWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Invitation isolation',
      slug: `invite-isolation-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const admin = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Invitation admin',
    });
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        await db.insert(workspaceMemberships).values({
          workspaceId: invitationWorkspace.id,
          userId: admin.id,
          role: 'admin',
          status: 'active',
        });
      },
    );

    await expect(
      identityDatabase.createWorkspaceInvitation({
        ...invitationCreateCommand(
          invitationWorkspace.id,
          admin.id,
          `${randomUUID()}@example.test`,
        ),
        role: 'builder',
      }),
    ).resolves.toMatchObject({ invitation: { role: 'builder' } });
    await expect(
      identityDatabase.createWorkspaceInvitation({
        ...invitationCreateCommand(
          invitationWorkspace.id,
          admin.id,
          `${randomUUID()}@example.test`,
        ),
        role: 'admin',
      }),
    ).rejects.toMatchObject({ reason: 'role_forbidden' });

    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        await db
          .update(workspaceMemberships)
          .set({ role: 'viewer' })
          .where(eq(workspaceMemberships.userId, admin.id));
      },
    );
    await expect(
      identityDatabase.createWorkspaceInvitation(
        invitationCreateCommand(
          invitationWorkspace.id,
          admin.id,
          `${randomUUID()}@example.test`,
        ),
      ),
    ).rejects.toMatchObject({ reason: 'actor_inactive' });
    await expect(
      identityDatabase.listWorkspaceInvitations(otherWorkspace.id, admin.id),
    ).rejects.toMatchObject({ reason: 'actor_inactive' });
  });

  it('invalidates resolved intents on resend and preserves the new generation', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation generation',
        slug: `invite-generation-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const created = await identityDatabase.createWorkspaceInvitation(
      invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
    );
    const intentId = randomUUID();
    const bindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await expect(
      identityDatabase.resolveInvitationAcceptance({
        workspaceId: invitationWorkspace.id,
        invitationId: created.invitation.id,
        tokenDigest: invitationTokenDigest(created.invitation.id),
        intentId,
        bindingDigest,
        csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      }),
    ).resolves.toBeNull();

    const knownDigest = createHash('sha256')
      .update('known-secret')
      .digest('hex');
    const known = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
      tokenDigest: knownDigest,
    });
    await expect(
      identityDatabase.resolveInvitationAcceptance({
        workspaceId: invitationWorkspace.id,
        invitationId: known.invitation.id,
        tokenDigest: knownDigest,
        intentId,
        bindingDigest,
        csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      }),
    ).resolves.toMatchObject({ status: 'pending', invitationRevision: 1 });
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        await db.execute(sql`
          update app.workspace_invitation_delivery_attempts
             set status='failed',token_ciphertext=null,token_nonce=null,
                 token_tag=null,token_key_version=null
           where invitation_id=${known.invitation.id}::uuid
             and invitation_revision=1
        `);
      },
    );
    await identityDatabase.resendWorkspaceInvitation({
      workspaceId: invitationWorkspace.id,
      actorUserId: ownerUserId,
      invitationId: known.invitation.id,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      tokenDigest: createHash('sha256').update('new-secret').digest('hex'),
      sealedToken: testSealedToken(),
      deliveryAttemptId: randomUUID(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
    });
    await expect(
      identityDatabase.readInvitationAcceptance(
        invitationWorkspace.id,
        bindingDigest,
      ),
    ).resolves.toMatchObject({ status: 'superseded', invitationRevision: 1 });
  });
}
