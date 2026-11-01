import { createHash, randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  identityDatabase,
  ownerUserId,
  invitationCreateCommand,
  createInvitationProofSession,
} from '../../fixture.js';

export function registerSerializesAcceptanceAgainstRevocationSo(): void {
  it('serializes acceptance against revocation so exactly one lifecycle command wins', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation lifecycle race',
        slug: `invite-race-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const recipient = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Invitation race recipient',
    });
    const tokenDigest = createHash('sha256')
      .update('race-secret')
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

    const outcomes = await Promise.allSettled([
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
      identityDatabase.revokeWorkspaceInvitation({
        workspaceId: invitationWorkspace.id,
        actorUserId: ownerUserId,
        invitationId: created.invitation.id,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    const access = await identityDatabase.findWorkspaceAccess(
      recipient.id,
      invitationWorkspace.id,
    );
    const page = await identityDatabase.listWorkspaceInvitations(
      invitationWorkspace.id,
      ownerUserId,
    );
    const invitation = page.items.find(
      (item) => item.id === created.invitation.id,
    );
    expect(
      (access === null && invitation?.status === 'revoked') ||
        (access?.membershipStatus === 'active' &&
          invitation?.status === 'accepted'),
    ).toBe(true);
  });
}
