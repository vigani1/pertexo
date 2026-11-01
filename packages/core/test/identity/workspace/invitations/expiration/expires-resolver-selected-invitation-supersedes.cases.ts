import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { expect, it } from 'vitest';

import {
  identityDatabase,
  tenantDatabase,
  ownerUserId,
  invitationTokenDigest,
  invitationCreateCommand,
} from '../../fixture.js';

export function registerExpiresResolverSelectedInvitationSupersedes(): void {
  it('expires a resolver-selected invitation and supersedes its open journey', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation resolver expiry',
        slug: `invite-resolve-expiry-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const command = invitationCreateCommand(
      invitationWorkspace.id,
      ownerUserId,
      `${randomUUID()}@example.test`,
    );
    const created = await identityDatabase.createWorkspaceInvitation(command);
    const intentId = randomUUID();
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: created.invitation.id,
      tokenDigest: command.tokenDigest,
      intentId,
      bindingDigest: invitationTokenDigest(randomUUID()),
      csrfDigest: invitationTokenDigest(randomUUID()),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        await db.execute(sql`
        update app.workspace_invitations
           set expires_at=clock_timestamp()-interval '1 second'
         where id=${created.invitation.id}::uuid
      `);
      },
    );
    await expect(
      identityDatabase.resolveInvitationAcceptance({
        workspaceId: invitationWorkspace.id,
        invitationId: created.invitation.id,
        tokenDigest: command.tokenDigest,
        intentId: randomUUID(),
        bindingDigest: invitationTokenDigest(randomUUID()),
        csrfDigest: invitationTokenDigest(randomUUID()),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      }),
    ).resolves.toBeNull();
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        const states = await db.execute(sql<{
          invitation_status: string;
          intent_status: string;
          attempt_status: string;
          token_ciphertext: string | null;
        }>`
        select invitation.status invitation_status,
               intent.status intent_status,
               attempt.status attempt_status,
               attempt.token_ciphertext
          from app.workspace_invitations invitation
          join app.workspace_invitation_acceptance_intents intent
            on intent.invitation_id=invitation.id
          join app.workspace_invitation_delivery_attempts attempt
            on attempt.invitation_id=invitation.id
         where invitation.id=${created.invitation.id}::uuid
           and intent.id=${intentId}::uuid
      `);
        expect(states.rows).toEqual([
          {
            invitation_status: 'expired',
            intent_status: 'superseded',
            attempt_status: 'canceled',
            token_ciphertext: null,
          },
        ]);
      },
    );
  });
}
