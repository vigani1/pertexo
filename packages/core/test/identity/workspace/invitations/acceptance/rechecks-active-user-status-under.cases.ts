import { waitForBlockedBy } from '../../../../support/postgres/lock-coordination.js';
import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { expect, it } from 'vitest';
import { workspaceMemberships } from '@pertexo/database/testing';

import {
  adminUrl,
  fixture,
  migrationUrl,
  identityDatabase,
  tenantDatabase,
  ownerUserId,
  createAuthenticationSession,
  findActiveAuthenticationSession,
  invitationCreateCommand,
  createInvitationProofSession,
} from '../../fixture.js';

export function registerRechecksActiveUserStatusUnder(): void {
  it('rechecks active user status under the acceptance transaction lock', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Suspended invitation recipient',
        slug: `invite-suspended-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const recipient = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Suspended recipient',
    });
    const tokenDigest = createHash('sha256')
      .update('suspended-recipient-secret')
      .digest('hex');
    const created = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        recipient.email,
      ),
      tokenDigest,
    });
    const intentId = randomUUID();
    const bindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: created.invitation.id,
      tokenDigest,
      intentId,
      bindingDigest,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await identityDatabase.recordInvitationAcceptanceProof({
      workspaceId: invitationWorkspace.id,
      intentId,
      bindingDigest,
      userId: recipient.id,
      sessionId: await createInvitationProofSession(recipient.id),
      verifiedEmail: recipient.email,
      verifiedAt: new Date(),
    });
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    const observer = new Pool({
      connectionString: fixture.databaseUrl(adminUrl),
      max: 1,
    });
    let completion: Promise<unknown> | undefined;
    try {
      await owner.query('begin');
      const blocker = await owner.query<{ pid: number }>(
        'select pg_backend_pid() as pid',
      );
      const blockerPid = blocker.rows[0]?.pid;
      if (blockerPid === undefined)
        throw new Error('Blocker PID is unavailable');
      await owner.query('set local role pertexo_owner');
      await owner.query(`update app.users set status='suspended' where id=$1`, [
        recipient.id,
      ]);
      completion = identityDatabase.completeInvitationAcceptance({
        workspaceId: invitationWorkspace.id,
        intentId,
        invitationRevision: 1,
        actorUserId: recipient.id,
        idempotencyKey: randomUUID(),
        replacementSession: {
          id: randomUUID(),
          token: createHash('sha256').update(randomUUID()).digest('hex'),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      void completion.catch(() => undefined);
      await waitForBlockedBy(observer, blockerPid);
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await Promise.all([owner.end(), observer.end()]);
    }

    await expect(completion).rejects.toMatchObject({
      reason: 'member_inactive',
    });
    await expect(
      identityDatabase.findWorkspaceAccess(
        recipient.id,
        invitationWorkspace.id,
      ),
    ).resolves.toBeNull();
  });

  it('accepts an active existing member as a no-op without changing role or sessions', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Existing member invitation',
        slug: `invite-member-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const recipient = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Existing invitation member',
    });
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        await db.insert(workspaceMemberships).values({
          workspaceId: invitationWorkspace.id,
          userId: recipient.id,
          role: 'operator',
          status: 'active',
        });
      },
    );
    const sessionToken = await createAuthenticationSession(recipient.id);
    const tokenDigest = createHash('sha256')
      .update('existing-member-secret')
      .digest('hex');
    const created = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        recipient.email,
      ),
      tokenDigest,
    });
    const intentId = randomUUID();
    const bindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: created.invitation.id,
      tokenDigest,
      intentId,
      bindingDigest,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await identityDatabase.recordInvitationAcceptanceProof({
      workspaceId: invitationWorkspace.id,
      intentId,
      bindingDigest,
      userId: recipient.id,
      sessionId: await createInvitationProofSession(recipient.id),
      verifiedEmail: recipient.email,
      verifiedAt: new Date(),
    });
    await expect(
      identityDatabase.completeInvitationAcceptance({
        workspaceId: invitationWorkspace.id,
        intentId,
        invitationRevision: 1,
        actorUserId: recipient.id,
        idempotencyKey: randomUUID(),
        replacementSession: {
          id: randomUUID(),
          token: createHash('sha256').update(randomUUID()).digest('hex'),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).resolves.toMatchObject({
      membershipCreated: false,
      role: 'operator',
      replacementSessionCreated: false,
    });
    await expect(
      findActiveAuthenticationSession(sessionToken),
    ).resolves.toMatchObject({ user_id: recipient.id });
  });
}
