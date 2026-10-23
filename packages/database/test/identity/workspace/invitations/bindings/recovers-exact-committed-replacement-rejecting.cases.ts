import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { expect, it } from 'vitest';

import {
  identityDatabase,
  tenantDatabase,
  ownerUserId,
  testSealedToken,
  invitationCreateCommand,
} from '../../fixture.js';

export function registerRecoversExactCommittedReplacementRejecting(): void {
  it('recovers the exact committed replacement while rejecting a competing journey', async () => {
    const priorWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Resolver recovery prior',
      slug: `resolver-recovery-prior-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const targetWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Resolver recovery target',
      slug: `resolver-recovery-target-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const priorTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const priorInvitation = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        priorWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
      tokenDigest: priorTokenDigest,
    });
    const priorIntentId = randomUUID();
    const priorBindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: priorWorkspace.id,
      invitationId: priorInvitation.invitation.id,
      tokenDigest: priorTokenDigest,
      intentId: priorIntentId,
      bindingDigest: priorBindingDigest,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    const targetTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const targetInvitation = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        targetWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
      tokenDigest: targetTokenDigest,
    });
    const competingTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const competingInvitation =
      await identityDatabase.createWorkspaceInvitation({
        ...invitationCreateCommand(
          targetWorkspace.id,
          ownerUserId,
          `${randomUUID()}@example.test`,
        ),
        tokenDigest: competingTokenDigest,
      });
    const replacement = {
      workspaceId: targetWorkspace.id,
      invitationId: targetInvitation.invitation.id,
      tokenDigest: targetTokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: {
        workspaceId: priorWorkspace.id,
        intentId: priorIntentId,
        bindingDigest: priorBindingDigest,
      },
    };
    const committed =
      await identityDatabase.resolveInvitationAcceptance(replacement);
    expect(committed).toMatchObject({
      id: replacement.intentId,
      status: 'pending',
    });

    const competitor = {
      ...replacement,
      invitationId: competingInvitation.invitation.id,
      tokenDigest: competingTokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
    };
    const [recovered, rejectedCompetitor] = await Promise.all([
      identityDatabase.resolveInvitationAcceptance(replacement),
      identityDatabase.resolveInvitationAcceptance(competitor),
    ]);
    expect(recovered).toMatchObject({
      id: replacement.intentId,
      status: 'pending',
    });
    expect(rejectedCompetitor).toBeNull();
    await expect(
      identityDatabase.readInvitationAcceptance(
        priorWorkspace.id,
        priorBindingDigest,
      ),
    ).resolves.toMatchObject({ status: 'abandoned' });
    await tenantDatabase.withWorkspace(targetWorkspace.id, async ({ db }) => {
      const durable = await db.execute(sql<{ count: number; kind: string }>`
          select 'membership' kind,count(*)::int count
            from app.workspace_memberships
           where workspace_id=${targetWorkspace.id}::uuid
          union all
          select 'acceptance_audit' kind,count(*)::int count
            from app.audit_events
           where workspace_id=${targetWorkspace.id}::uuid
             and action='workspace.invitation_accepted'
        `);
      expect(durable.rows).toEqual(
        expect.arrayContaining([
          { kind: 'membership', count: 1 },
          { kind: 'acceptance_audit', count: 0 },
        ]),
      );
    });
    await tenantDatabase.withWorkspace(targetWorkspace.id, async ({ db }) => {
      await db.execute(sql`
          update app.workspace_invitation_delivery_attempts
             set status='failed',token_ciphertext=null,token_nonce=null,
                 token_tag=null,token_key_version=null
           where invitation_id=${targetInvitation.invitation.id}::uuid
             and invitation_revision=1
        `);
    });
    const refreshedTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resendWorkspaceInvitation({
      workspaceId: targetWorkspace.id,
      actorUserId: ownerUserId,
      invitationId: targetInvitation.invitation.id,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      tokenDigest: refreshedTokenDigest,
      sealedToken: testSealedToken(),
      deliveryAttemptId: randomUUID(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
    });
    await expect(
      identityDatabase.resolveInvitationAcceptance({
        ...replacement,
        tokenDigest: refreshedTokenDigest,
        intentId: randomUUID(),
        bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      }),
    ).resolves.toMatchObject({
      invitationId: targetInvitation.invitation.id,
      invitationRevision: 2,
      status: 'pending',
    });
  });
}
