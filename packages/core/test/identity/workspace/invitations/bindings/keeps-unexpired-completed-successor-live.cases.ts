import { createHash, randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  identityDatabase,
  ownerUserId,
  invitationCreateCommand,
  createInvitationProofSession,
} from '../../fixture.js';

export function registerKeepsUnexpiredCompletedSuccessorLive(): void {
  it('keeps an unexpired completed successor live against a stale ancestor replacement', async () => {
    const priorWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Completed lineage prior',
      slug: `completed-prior-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const successorWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Completed lineage successor',
      slug: `completed-successor-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const staleWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Completed lineage stale target',
      slug: `completed-stale-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const recipient = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Completed lineage recipient',
    });
    const createJourney = async (workspaceId: string, email: string) => {
      const tokenDigest = createHash('sha256')
        .update(randomUUID())
        .digest('hex');
      const invitation = await identityDatabase.createWorkspaceInvitation({
        ...invitationCreateCommand(workspaceId, ownerUserId, email),
        tokenDigest,
      });
      return { invitation: invitation.invitation, tokenDigest };
    };
    const prior = await createJourney(
      priorWorkspace.id,
      `${randomUUID()}@example.test`,
    );
    const successor = await createJourney(
      successorWorkspace.id,
      recipient.email,
    );
    const stale = await createJourney(
      staleWorkspace.id,
      `${randomUUID()}@example.test`,
    );
    const priorIntent = {
      workspaceId: priorWorkspace.id,
      invitationId: prior.invitation.id,
      tokenDigest: prior.tokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    };
    await identityDatabase.resolveInvitationAcceptance(priorIntent);
    const successorIntent = {
      workspaceId: successorWorkspace.id,
      invitationId: successor.invitation.id,
      tokenDigest: successor.tokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: {
        workspaceId: priorWorkspace.id,
        intentId: priorIntent.intentId,
        bindingDigest: priorIntent.bindingDigest,
      },
    };
    await identityDatabase.resolveInvitationAcceptance(successorIntent);
    await identityDatabase.recordInvitationAcceptanceProof({
      workspaceId: successorWorkspace.id,
      intentId: successorIntent.intentId,
      bindingDigest: successorIntent.bindingDigest,
      userId: recipient.id,
      sessionId: await createInvitationProofSession(recipient.id),
      verifiedEmail: recipient.email,
      verifiedAt: new Date(),
    });
    await identityDatabase.completeInvitationAcceptance({
      workspaceId: successorWorkspace.id,
      intentId: successorIntent.intentId,
      invitationRevision: 1,
      actorUserId: recipient.id,
      idempotencyKey: randomUUID(),
      replacementSession: {
        id: randomUUID(),
        token: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await expect(
      identityDatabase.resolveInvitationAcceptance({
        workspaceId: staleWorkspace.id,
        invitationId: stale.invitation.id,
        tokenDigest: stale.tokenDigest,
        intentId: randomUUID(),
        bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 15 * 60_000),
        priorBinding: successorIntent.priorBinding,
      }),
    ).resolves.toBeNull();
    await expect(
      identityDatabase.readInvitationAcceptance(
        successorWorkspace.id,
        successorIntent.bindingDigest,
      ),
    ).resolves.toMatchObject({
      id: successorIntent.intentId,
      status: 'completed',
    });
  });
}
