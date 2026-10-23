import { createHash, randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  identityDatabase,
  ownerUserId,
  invitationCreateCommand,
  createInvitationProofSession,
} from '../../fixture.js';

export function registerInvalidatesReplacedBrowserBindingWithout(): void {
  it('invalidates a replaced browser binding without revoking the invitation', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation binding replacement',
        slug: `invite-binding-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const recipient = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Binding replacement recipient',
    });
    const tokenDigest = createHash('sha256')
      .update('binding-secret')
      .digest('hex');
    const created = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        recipient.email,
      ),
      tokenDigest,
    });
    const oldIntentId = randomUUID();
    const oldBinding = createHash('sha256').update(randomUUID()).digest('hex');
    const newIntentId = randomUUID();
    const newBinding = createHash('sha256').update(randomUUID()).digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: created.invitation.id,
      tokenDigest,
      intentId: oldIntentId,
      bindingDigest: oldBinding,
      csrfDigest: createHash('sha256')
        .update(`csrf:${oldIntentId}`)
        .digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: created.invitation.id,
      tokenDigest,
      intentId: newIntentId,
      bindingDigest: newBinding,
      csrfDigest: createHash('sha256')
        .update(`csrf:${newIntentId}`)
        .digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: {
        workspaceId: invitationWorkspace.id,
        intentId: oldIntentId,
        bindingDigest: oldBinding,
      },
    });

    await expect(
      identityDatabase.recordInvitationAcceptanceProof({
        workspaceId: invitationWorkspace.id,
        intentId: oldIntentId,
        bindingDigest: oldBinding,
        userId: recipient.id,
        sessionId: await createInvitationProofSession(recipient.id),
        verifiedEmail: recipient.email,
        verifiedAt: new Date(),
      }),
    ).resolves.toBeNull();
    await expect(
      identityDatabase.recordInvitationAcceptanceProof({
        workspaceId: invitationWorkspace.id,
        intentId: newIntentId,
        bindingDigest: newBinding,
        userId: recipient.id,
        sessionId: await createInvitationProofSession(recipient.id),
        verifiedEmail: recipient.email,
        verifiedAt: new Date(),
      }),
    ).resolves.toMatchObject({ status: 'verified' });
    const invitations = await identityDatabase.listWorkspaceInvitations(
      invitationWorkspace.id,
      ownerUserId,
    );
    expect(
      invitations.items.find((item) => item.id === created.invitation.id),
    ).toMatchObject({ status: 'pending' });
  });
}
