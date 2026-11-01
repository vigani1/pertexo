import { createHash, randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';
import { InvitationAcceptanceConflictError } from '../../../../../src/tenant-access/index.js';

import {
  identityDatabase,
  ownerUserId,
  invitationCreateCommand,
  createInvitationProofSession,
} from '../../fixture.js';

export function registerMarksOtherAccountProofWrong(): void {
  it('marks a proof from a different signed-in address as the wrong account and refuses completion', async () => {
    const workspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Wrong account',
      slug: `wrong-account-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const [recipient, other] = await Promise.all(
      ['Invited recipient', 'Other account'].map((displayName) =>
        identityDatabase.createUser({
          email: `${randomUUID()}@example.test`,
          displayName,
        }),
      ),
    );
    if (recipient === undefined || other === undefined)
      throw new Error('Wrong-account users were not created');
    const tokenDigest = createHash('sha256').update(randomUUID()).digest('hex');
    const created = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(workspace.id, ownerUserId, recipient.email),
      tokenDigest,
    });
    const intentId = randomUUID();
    const bindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: workspace.id,
      invitationId: created.invitation.id,
      tokenDigest,
      intentId,
      bindingDigest,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });

    await expect(
      identityDatabase.recordInvitationAcceptanceProof({
        workspaceId: workspace.id,
        intentId,
        bindingDigest,
        userId: other.id,
        sessionId: await createInvitationProofSession(other.id),
        verifiedEmail: other.email,
        verifiedAt: new Date(),
      }),
    ).resolves.toMatchObject({ status: 'wrong_account' });
    await expect(
      identityDatabase.completeInvitationAcceptance({
        workspaceId: workspace.id,
        intentId,
        invitationRevision: 1,
        actorUserId: other.id,
        idempotencyKey: randomUUID(),
        replacementSession: {
          id: randomUUID(),
          token: createHash('sha256').update(randomUUID()).digest('hex'),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toBeInstanceOf(InvitationAcceptanceConflictError);
    await expect(
      identityDatabase.findWorkspaceAccess(other.id, workspace.id),
    ).resolves.toBeNull();
  });
}
