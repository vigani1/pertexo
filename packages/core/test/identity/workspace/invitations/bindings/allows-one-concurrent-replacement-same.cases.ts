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

export function registerAllowsOneConcurrentReplacementSame(): void {
  it('allows only one concurrent replacement of the same browser binding and rolls back failed replacement', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation binding concurrency',
        slug: `invite-binding-race-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const tokenDigest = createHash('sha256').update(randomUUID()).digest('hex');
    const created = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
      tokenDigest,
    });
    const oldIntentId = randomUUID();
    const oldBinding = createHash('sha256').update(randomUUID()).digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: created.invitation.id,
      tokenDigest,
      intentId: oldIntentId,
      bindingDigest: oldBinding,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    const replacementWorkspace =
      await identityDatabase.createWorkspaceWithOwner({
        name: 'Invitation binding replacement target',
        slug: `invite-binding-target-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      });
    const replacementTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const replacementInvitation =
      await identityDatabase.createWorkspaceInvitation({
        ...invitationCreateCommand(
          replacementWorkspace.id,
          ownerUserId,
          `${randomUUID()}@example.test`,
        ),
        tokenDigest: replacementTokenDigest,
      });
    const replacement = () => ({
      workspaceId: replacementWorkspace.id,
      invitationId: replacementInvitation.invitation.id,
      tokenDigest: replacementTokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: {
        workspaceId: invitationWorkspace.id,
        intentId: oldIntentId,
        bindingDigest: oldBinding,
      },
    });
    const replacementA = replacement();
    const replacementB = replacement();
    const outcomes = await Promise.all([
      identityDatabase.resolveInvitationAcceptance(replacementA),
      identityDatabase.resolveInvitationAcceptance(replacementB),
    ]);
    expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1);
    await tenantDatabase.withWorkspace(
      replacementWorkspace.id,
      async ({ db }) => {
        const active = await db.execute(sql`
          select count(*)::int count
            from app.workspace_invitation_acceptance_intents
           where invitation_id=${replacementInvitation.invitation.id}::uuid
             and status in ('pending','verified','wrong_account')
        `);
        expect(active.rows[0]?.count).toBe(1);
      },
    );

    const active = outcomes.find((outcome) => outcome !== null);
    expect(active).not.toBeNull();
    const activeBinding =
      active?.id === replacementA.intentId
        ? replacementA.bindingDigest
        : replacementB.bindingDigest;
    await expect(
      identityDatabase.resolveInvitationAcceptance({
        ...replacement(),
        bindingDigest: activeBinding,
        priorBinding: {
          workspaceId: replacementWorkspace.id,
          intentId: active?.id ?? oldIntentId,
          bindingDigest: activeBinding,
        },
      }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'workspace_invitation_intents_binding_unique',
    });
    await expect(
      identityDatabase.readInvitationAcceptance(
        replacementWorkspace.id,
        activeBinding,
      ),
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('does not rotate an invitation while delivery outcome is unknown', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation delivery recovery',
        slug: `invite-delivery-${randomUUID().slice(0, 8)}`,
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
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        await db.execute(sql`
          update app.workspace_invitation_delivery_attempts
             set status='unknown'
           where invitation_id=${created.invitation.id}::uuid
             and invitation_revision=1
        `);
      },
    );

    await expect(
      identityDatabase.resendWorkspaceInvitation({
        workspaceId: invitationWorkspace.id,
        actorUserId: ownerUserId,
        invitationId: created.invitation.id,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        tokenDigest: createHash('sha256').update('new-secret').digest('hex'),
        sealedToken: testSealedToken(),
        deliveryAttemptId: randomUUID(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      }),
    ).rejects.toMatchObject({ reason: 'delivery_unresolved' });
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        const attempt = await db.execute(sql<{ id: string }>`
          select status,token_ciphertext is not null sealed
            from app.workspace_invitation_delivery_attempts
           where invitation_id=${created.invitation.id}::uuid
             and invitation_revision=1
        `);
        expect(attempt.rows[0]).toEqual({ status: 'unknown', sealed: true });
      },
    );
  });
}
