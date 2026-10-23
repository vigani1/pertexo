import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { expect, it } from 'vitest';

import { enforceRetention } from '../../../../support/retention.js';
import {
  migrationUrl,
  maintenanceUrl,
  identityDatabase,
  tenantDatabase,
  ownerUserId,
  invitationCreateCommand,
  createInvitationProofSession,
} from '../../fixture.js';

export function registerSerializesReplacementClaimCleanupAcceptance(): void {
  it('serializes replacement-claim cleanup with acceptance without duplicating durable effects', async () => {
    const recipient = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Claim cleanup acceptance recipient',
    });
    const priorWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Claim cleanup acceptance prior',
      slug: `claim-cleanup-prior-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const targetWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Claim cleanup acceptance target',
      slug: `claim-cleanup-target-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const priorTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const targetTokenDigest = createHash('sha256')
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
    const targetInvitation = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        targetWorkspace.id,
        ownerUserId,
        recipient.email,
      ),
      tokenDigest: targetTokenDigest,
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
    const targetIntentId = randomUUID();
    const targetBindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: targetWorkspace.id,
      invitationId: targetInvitation.invitation.id,
      tokenDigest: targetTokenDigest,
      intentId: targetIntentId,
      bindingDigest: targetBindingDigest,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: {
        workspaceId: priorWorkspace.id,
        intentId: priorIntentId,
        bindingDigest: priorBindingDigest,
      },
    });
    await identityDatabase.recordInvitationAcceptanceProof({
      workspaceId: targetWorkspace.id,
      intentId: targetIntentId,
      bindingDigest: targetBindingDigest,
      userId: recipient.id,
      sessionId: await createInvitationProofSession(recipient.id),
      verifiedEmail: recipient.email,
      verifiedAt: new Date(),
    });
    const command = {
      workspaceId: targetWorkspace.id,
      intentId: targetIntentId,
      invitationRevision: 1,
      actorUserId: recipient.id,
      idempotencyKey: randomUUID(),
      replacementSession: {
        id: randomUUID(),
        token: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    };
    const [cleanup, accepted] = await Promise.allSettled([
      enforceRetention(maintenanceUrl),
      identityDatabase.completeInvitationAcceptance(command),
    ]);
    expect(cleanup.status).toBe('fulfilled');
    expect(accepted).toMatchObject({
      status: 'fulfilled',
      value: { membershipCreated: true, replayed: false },
    });
    await expect(
      identityDatabase.completeInvitationAcceptance(command),
    ).resolves.toMatchObject({ membershipCreated: true, replayed: true });
    await tenantDatabase.withWorkspace(targetWorkspace.id, async ({ db }) => {
      const durable = await db.execute(sql<{ count: number; kind: string }>`
        select 'membership' kind,count(*)::integer count
          from app.workspace_memberships where user_id=${recipient.id}::uuid
        union all
        select 'audit' kind,count(*)::integer count from app.audit_events
         where action='workspace.invitation_accepted'
           and actor_user_id=${recipient.id}::uuid
      `);
      expect(durable.rows).toEqual(
        expect.arrayContaining([
          { kind: 'membership', count: 1 },
          { kind: 'audit', count: 1 },
        ]),
      );
    });
  });

  it('opens a valid invitation when the cookie references a pruned intent', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Pruned invitation replacement',
        slug: `invite-pruned-binding-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const oldTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const oldInvitation = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
      tokenDigest: oldTokenDigest,
    });
    const oldIntentId = randomUUID();
    const oldBinding = createHash('sha256').update(randomUUID()).digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: oldInvitation.invitation.id,
      tokenDigest: oldTokenDigest,
      intentId: oldIntentId,
      bindingDigest: oldBinding,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('set role pertexo_owner');
      await owner.query(
        'delete from app.workspace_invitation_acceptance_intents where id=$1',
        [oldIntentId],
      );
    } finally {
      await owner.end();
    }
    const validTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const validInvitation = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
      tokenDigest: validTokenDigest,
    });

    await expect(
      identityDatabase.resolveInvitationAcceptance({
        workspaceId: invitationWorkspace.id,
        invitationId: validInvitation.invitation.id,
        tokenDigest: validTokenDigest,
        intentId: randomUUID(),
        bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 15 * 60_000),
        priorBinding: {
          workspaceId: invitationWorkspace.id,
          intentId: oldIntentId,
          bindingDigest: oldBinding,
        },
      }),
    ).resolves.toMatchObject({
      status: 'pending',
      invitationId: validInvitation.invitation.id,
    });
  });
}
