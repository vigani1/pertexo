import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';

import {
  createInvitationProofSession,
  identityDatabase,
  invitationCreateCommand,
  invitationTokenDigest,
  ownerUserId,
  tenantDatabase,
} from '../../fixture.js';

async function pendingInvitation() {
  const workspace = await identityDatabase.createWorkspaceWithOwner({
    name: 'Invitation gap',
    slug: `invite-gap-${randomUUID().slice(0, 8)}`,
    ownerUserId,
  });
  const recipient = await identityDatabase.createUser({
    email: `${randomUUID()}@example.test`,
    displayName: 'Invited recipient',
  });
  const command = invitationCreateCommand(
    workspace.id,
    ownerUserId,
    recipient.email,
  );
  const { invitation } =
    await identityDatabase.createWorkspaceInvitation(command);
  return { workspace, recipient, command, invitation };
}

function setExpiry(workspaceId: string, invitationId: string, at: string) {
  return tenantDatabase.withWorkspace(workspaceId, ({ db }) =>
    db.execute(sql`
      update app.workspace_invitations
         set expires_at=clock_timestamp()+${at}::interval
       where id=${invitationId}::uuid`),
  );
}

/**
 * Retention can take five minutes to move an invitation to expired, so these
 * look at one past its time with no retention pass having run.
 */
export function registerShowsExpiredBeforeRetentionRuns(): void {
  it('lists an invitation past its time as expired before retention has run', async () => {
    const { workspace, invitation } = await pendingInvitation();
    await setExpiry(workspace.id, invitation.id, '-1 second');

    const { items } = await identityDatabase.listWorkspaceInvitations(
      workspace.id,
      ownerUserId,
    );

    expect(items.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: invitation.id, status: 'expired' },
    ]);
  });

  it('still lists one inside its time as pending', async () => {
    const { workspace, invitation } = await pendingInvitation();
    await setExpiry(workspace.id, invitation.id, '1 minute');

    const { items } = await identityDatabase.listWorkspaceInvitations(
      workspace.id,
      ownerUserId,
    );

    expect(items.map(({ status }) => status)).toEqual(['pending']);
  });

  it('refuses to complete an acceptance whose invitation passed its time mid-journey', async () => {
    const { workspace, recipient, command, invitation } =
      await pendingInvitation();
    const intentId = randomUUID();
    const bindingDigest = invitationTokenDigest(randomUUID());
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: workspace.id,
      invitationId: invitation.id,
      tokenDigest: command.tokenDigest,
      intentId,
      bindingDigest,
      csrfDigest: invitationTokenDigest(randomUUID()),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await identityDatabase.recordInvitationAcceptanceProof({
      workspaceId: workspace.id,
      intentId,
      bindingDigest,
      userId: recipient.id,
      sessionId: await createInvitationProofSession(recipient.id),
      verifiedEmail: recipient.email,
      verifiedAt: new Date(),
    });
    await setExpiry(workspace.id, invitation.id, '-1 second');

    await expect(
      identityDatabase.completeInvitationAcceptance({
        workspaceId: workspace.id,
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
    ).rejects.toMatchObject({ name: 'InvitationAcceptanceConflictError' });

    const members = await tenantDatabase.withWorkspace(workspace.id, ({ db }) =>
      db.execute(sql`
          select 1 from app.workspace_memberships
           where workspace_id=${workspace.id}::uuid
             and user_id=${recipient.id}::uuid`),
    );
    expect(members.rows).toEqual([]);
  });
}
