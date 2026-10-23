import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { expect, it } from 'vitest';

import {
  identityDatabase,
  tenantDatabase,
  ownerUserId,
  invitationTokenDigest,
  invitationCreateCommand,
  createInvitationProofSession,
} from '../../fixture.js';

export function registerRetiresEvidenceLeftBehindBy(): void {
  it('retires evidence left behind by an already-expired invitation, including verified and wrong-account journeys', async () => {
    const workspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Prior invitation expiry',
      slug: `invite-prior-expiry-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    for (const intentStatus of ['verified', 'wrong_account'] as const) {
      const command = invitationCreateCommand(
        workspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      );
      const invitation =
        await identityDatabase.createWorkspaceInvitation(command);
      const intentId = randomUUID();
      await identityDatabase.resolveInvitationAcceptance({
        workspaceId: workspace.id,
        invitationId: invitation.invitation.id,
        tokenDigest: command.tokenDigest,
        intentId,
        bindingDigest: invitationTokenDigest(randomUUID()),
        csrfDigest: invitationTokenDigest(randomUUID()),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });
      await tenantDatabase.withWorkspace(workspace.id, async ({ db }) => {
        await db.execute(sql`
          update app.workspace_invitations
             set status='expired',delivery_status='canceled',
                 expires_at=clock_timestamp()-interval '1 second'
           where id=${invitation.invitation.id}::uuid
        `);
        await db.execute(sql`
          update app.workspace_invitation_delivery_attempts
             set status='unknown'
           where invitation_id=${invitation.invitation.id}::uuid
        `);
        await db.execute(sql`
          update app.workspace_invitation_acceptance_intents
             set status=${intentStatus}
           where id=${intentId}::uuid
        `);
      });
      await identityDatabase.listWorkspaceInvitations(
        workspace.id,
        ownerUserId,
      );
      await tenantDatabase.withWorkspace(workspace.id, async ({ db }) => {
        const result = await db.execute(sql<{
          attempt_status: string;
          token_ciphertext: string | null;
          intent_status: string;
        }>`
          select attempt.status attempt_status,attempt.token_ciphertext,
                 intent.status intent_status
            from app.workspace_invitation_delivery_attempts attempt
            join app.workspace_invitation_acceptance_intents intent
              on intent.invitation_id=attempt.invitation_id
           where attempt.invitation_id=${invitation.invitation.id}::uuid
             and intent.id=${intentId}::uuid
        `);
        expect(result.rows).toEqual([
          {
            attempt_status: 'unknown',
            token_ciphertext: null,
            intent_status: 'superseded',
          },
        ]);
      });
    }
  });

  it('serializes expired-list cleanup with a verified acceptance without granting membership', async () => {
    const workspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Invitation expiry acceptance race',
      slug: `invite-expiry-race-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const recipient = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Expiry race recipient',
    });
    const command = invitationCreateCommand(
      workspace.id,
      ownerUserId,
      recipient.email,
    );
    const invitation =
      await identityDatabase.createWorkspaceInvitation(command);
    const intentId = randomUUID();
    const bindingDigest = invitationTokenDigest(randomUUID());
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: workspace.id,
      invitationId: invitation.invitation.id,
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
    await tenantDatabase.withWorkspace(workspace.id, async ({ db }) => {
      await db.execute(sql`
        update app.workspace_invitations
           set expires_at=clock_timestamp()-interval '1 second'
         where id=${invitation.invitation.id}::uuid
      `);
    });
    const [list, acceptance] = await Promise.allSettled([
      identityDatabase.listWorkspaceInvitations(workspace.id, ownerUserId),
      identityDatabase.completeInvitationAcceptance({
        workspaceId: workspace.id,
        intentId,
        invitationRevision: invitation.invitation.revision,
        actorUserId: recipient.id,
        idempotencyKey: randomUUID(),
        replacementSession: {
          id: randomUUID(),
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ]);
    expect(list.status).toBe('fulfilled');
    expect(acceptance).toMatchObject({
      status: 'rejected',
      reason: { reason: 'superseded' },
    });
    await tenantDatabase.withWorkspace(workspace.id, async ({ db }) => {
      const state = await db.execute(sql<{
        invitation_status: string;
        intent_status: string;
        memberships: number;
      }>`
        select invitation.status invitation_status,intent.status intent_status,
               (select count(*)::int from app.workspace_memberships membership
                 where membership.workspace_id=invitation.workspace_id
                   and membership.user_id=${recipient.id}::uuid) memberships
          from app.workspace_invitations invitation
          join app.workspace_invitation_acceptance_intents intent
            on intent.invitation_id=invitation.id
         where invitation.id=${invitation.invitation.id}::uuid
           and intent.id=${intentId}::uuid
      `);
      expect(state.rows).toEqual([
        {
          invitation_status: 'expired',
          intent_status: 'superseded',
          memberships: 0,
        },
      ]);
    });
  });
}
