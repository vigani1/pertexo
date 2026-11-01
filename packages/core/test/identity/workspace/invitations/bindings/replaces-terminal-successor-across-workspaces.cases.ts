import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { expect, it } from 'vitest';

import { enforceRetention } from '../../../../support/retention.js';
import {
  maintenanceUrl,
  identityDatabase,
  tenantDatabase,
  ownerUserId,
  findActiveAuthenticationSession,
  invitationCreateCommand,
  createInvitationProofSession,
} from '../../fixture.js';

export function registerReplacesTerminalSuccessorAcrossWorkspaces(): void {
  it('replaces a terminal successor across workspaces without exposing its tenant row', async () => {
    const priorWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Cross-workspace prior',
      slug: `cross-prior-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const firstTarget = await identityDatabase.createWorkspaceWithOwner({
      name: 'Cross-workspace terminal target',
      slug: `cross-terminal-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const finalTarget = await identityDatabase.createWorkspaceWithOwner({
      name: 'Cross-workspace fresh target',
      slug: `cross-fresh-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const createInvitation = async (workspaceId: string) => {
      const tokenDigest = createHash('sha256')
        .update(randomUUID())
        .digest('hex');
      const created = await identityDatabase.createWorkspaceInvitation({
        ...invitationCreateCommand(
          workspaceId,
          ownerUserId,
          `${randomUUID()}@example.test`,
        ),
        tokenDigest,
      });
      return { tokenDigest, invitationId: created.invitation.id };
    };
    const priorInvitation = await createInvitation(priorWorkspace.id);
    const firstInvitation = await createInvitation(firstTarget.id);
    const finalInvitation = await createInvitation(finalTarget.id);
    const prior = {
      workspaceId: priorWorkspace.id,
      invitationId: priorInvitation.invitationId,
      tokenDigest: priorInvitation.tokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    };
    await identityDatabase.resolveInvitationAcceptance(prior);
    const first = {
      workspaceId: firstTarget.id,
      invitationId: firstInvitation.invitationId,
      tokenDigest: firstInvitation.tokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: {
        workspaceId: priorWorkspace.id,
        intentId: prior.intentId,
        bindingDigest: prior.bindingDigest,
      },
    };
    await identityDatabase.resolveInvitationAcceptance(first);
    await tenantDatabase.withWorkspace(firstTarget.id, async ({ db }) => {
      await db.execute(sql`
        update app.workspace_invitation_acceptance_intents
           set status='superseded',updated_at=clock_timestamp()
         where id=${first.intentId}::uuid
      `);
    });
    const final = {
      workspaceId: finalTarget.id,
      invitationId: finalInvitation.invitationId,
      tokenDigest: finalInvitation.tokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: first.priorBinding,
    };

    const [cleanup, resolution] = await Promise.allSettled([
      enforceRetention(maintenanceUrl),
      identityDatabase.resolveInvitationAcceptance(final),
    ]);
    expect(cleanup.status).toBe('fulfilled');
    expect(resolution).toMatchObject({
      status: 'fulfilled',
      value: { id: final.intentId, status: 'pending' },
    });
    await expect(
      identityDatabase.readInvitationAcceptance(
        firstTarget.id,
        first.bindingDigest,
      ),
    ).resolves.toMatchObject({ status: 'superseded' });
  });

  it('opens another invitation without mutating a completed receipt journey', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Completed invitation replacement',
        slug: `invite-completed-binding-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const recipient = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Completed binding recipient',
    });
    const firstTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const first = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        recipient.email,
      ),
      tokenDigest: firstTokenDigest,
    });
    const completedIntentId = randomUUID();
    const completedBinding = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: first.invitation.id,
      tokenDigest: firstTokenDigest,
      intentId: completedIntentId,
      bindingDigest: completedBinding,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await identityDatabase.recordInvitationAcceptanceProof({
      workspaceId: invitationWorkspace.id,
      intentId: completedIntentId,
      bindingDigest: completedBinding,
      userId: recipient.id,
      sessionId: await createInvitationProofSession(recipient.id),
      verifiedEmail: recipient.email,
      verifiedAt: new Date(),
    });
    const replacementSessionToken = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.completeInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      intentId: completedIntentId,
      invitationRevision: 1,
      actorUserId: recipient.id,
      idempotencyKey: randomUUID(),
      replacementSession: {
        id: randomUUID(),
        token: replacementSessionToken,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const secondTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const second = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
      tokenDigest: secondTokenDigest,
    });

    await expect(
      identityDatabase.resolveInvitationAcceptance({
        workspaceId: invitationWorkspace.id,
        invitationId: second.invitation.id,
        tokenDigest: secondTokenDigest,
        intentId: randomUUID(),
        bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 15 * 60_000),
        priorBinding: {
          workspaceId: invitationWorkspace.id,
          intentId: completedIntentId,
          bindingDigest: completedBinding,
        },
      }),
    ).resolves.toMatchObject({
      status: 'pending',
      invitationId: second.invitation.id,
    });
    await expect(
      identityDatabase.readInvitationAcceptance(
        invitationWorkspace.id,
        completedBinding,
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      acceptedUserId: recipient.id,
    });
    await expect(
      findActiveAuthenticationSession(replacementSessionToken),
    ).resolves.toEqual({ user_id: recipient.id });
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        const durable = await db.execute(sql<{ count: number; kind: string }>`
          select 'membership' kind,count(*)::int count
            from app.workspace_memberships where user_id=${recipient.id}::uuid
          union all
          select 'audit' kind,count(*)::int count
            from app.audit_events
           where action='workspace.invitation_accepted'
             and actor_user_id=${recipient.id}::uuid
        `);
        expect(durable.rows).toEqual(
          expect.arrayContaining([
            { kind: 'membership', count: 1 },
            { kind: 'audit', count: 1 },
          ]),
        );
      },
    );
  });
}
