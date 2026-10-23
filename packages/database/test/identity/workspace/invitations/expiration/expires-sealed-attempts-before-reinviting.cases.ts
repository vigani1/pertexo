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

export function registerExpiresSealedAttemptsBeforeReinviting(): void {
  it('expires sealed attempts before reinviting the same normalized recipient', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation reinvite',
        slug: `invite-reinvite-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const email = `${randomUUID()}@example.test`;
    const firstCommand = invitationCreateCommand(
      invitationWorkspace.id,
      ownerUserId,
      email,
    );
    const first =
      await identityDatabase.createWorkspaceInvitation(firstCommand);
    const oldIntentId = randomUUID();
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: first.invitation.id,
      tokenDigest: firstCommand.tokenDigest,
      intentId: oldIntentId,
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
          where id=${first.invitation.id}::uuid
      `);
        await db.execute(sql`
          update app.workspace_invitation_delivery_attempts
             set status='unknown'
           where invitation_id=${first.invitation.id}::uuid
        `);
      },
    );

    const replacement = await identityDatabase.createWorkspaceInvitation(
      invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        email.toUpperCase(),
      ),
    );
    expect(replacement.invitation.id).not.toBe(first.invitation.id);
    const page = await identityDatabase.listWorkspaceInvitations(
      invitationWorkspace.id,
      ownerUserId,
    );
    expect(
      page.items.find((item) => item.id === first.invitation.id),
    ).toMatchObject({ status: 'expired', deliveryStatus: 'canceled' });
    expect(
      page.items.find((item) => item.id === replacement.invitation.id),
    ).toMatchObject({ status: 'pending' });
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        const attempt = await db.execute(sql<{
          status: string;
          token_ciphertext: string | null;
        }>`
          select status,token_ciphertext
            from app.workspace_invitation_delivery_attempts
           where invitation_id=${first.invitation.id}::uuid
        `);
        expect(attempt.rows).toEqual([
          { status: 'unknown', token_ciphertext: null },
        ]);
        const intent = await db.execute(sql<{ status: string }>`
          select status from app.workspace_invitation_acceptance_intents
           where id=${oldIntentId}::uuid
        `);
        expect(intent.rows).toEqual([{ status: 'superseded' }]);
      },
    );
  });

  it('expires queued, failed, unknown and submitted deliveries through listing without erasing uncertainty', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation list expiry',
        slug: `invite-list-expiry-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const cases = ['queued', 'failed', 'unknown', 'submitted'] as const;
    const invitations = [];
    for (const status of cases) {
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
          update app.workspace_invitation_delivery_attempts
             set status=${status},
                 token_ciphertext=case when ${status}='submitted' then null else token_ciphertext end,
                 token_nonce=case when ${status}='submitted' then null else token_nonce end,
                 token_tag=case when ${status}='submitted' then null else token_tag end,
                 token_key_version=case when ${status}='submitted' then null else token_key_version end
           where invitation_id=${created.invitation.id}::uuid
        `);
          await db.execute(sql`
          update app.workspace_invitations
             set expires_at=clock_timestamp()-interval '1 second'
           where id=${created.invitation.id}::uuid
        `);
        },
      );
      invitations.push({
        invitationId: created.invitation.id,
        intentId,
        status,
      });
    }
    const page = await identityDatabase.listWorkspaceInvitations(
      invitationWorkspace.id,
      ownerUserId,
    );
    expect(page.items).toHaveLength(cases.length);
    for (const { invitationId, intentId, status } of invitations) {
      expect(page.items.find((item) => item.id === invitationId)).toMatchObject(
        {
          status: 'expired',
          deliveryStatus: 'canceled',
        },
      );
      await tenantDatabase.withWorkspace(
        invitationWorkspace.id,
        async ({ db }) => {
          const evidence = await db.execute(sql<{
            attempt_status: string;
            intent_status: string;
            token_ciphertext: string | null;
          }>`
          select attempt.status attempt_status,
                 attempt.token_ciphertext,
                 intent.status intent_status
            from app.workspace_invitation_delivery_attempts attempt
            join app.workspace_invitation_acceptance_intents intent
              on intent.invitation_id=attempt.invitation_id
           where attempt.invitation_id=${invitationId}::uuid
             and intent.id=${intentId}::uuid
        `);
          expect(evidence.rows).toEqual([
            {
              attempt_status:
                status === 'submitted' || status === 'unknown'
                  ? status
                  : 'canceled',
              intent_status: 'superseded',
              token_ciphertext: null,
            },
          ]);
        },
      );
    }
  });
}
