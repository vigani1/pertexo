import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { expect, it } from 'vitest';

import {
  migrationUrl,
  identityDatabase,
  tenantDatabase,
  ownerUserId,
  testSealedToken,
  invitationCreateCommand,
} from '../../fixture.js';

export function registerReplacesSupersededResendJourneyValid(): void {
  it('replaces a superseded resend journey with the valid new generation', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation resend replacement',
        slug: `invite-resend-binding-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const oldTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const created = await identityDatabase.createWorkspaceInvitation({
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
      invitationId: created.invitation.id,
      tokenDigest: oldTokenDigest,
      intentId: oldIntentId,
      bindingDigest: oldBinding,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        await db.execute(sql`
          update app.workspace_invitation_delivery_attempts
             set status='failed',token_ciphertext=null,token_nonce=null,
                 token_tag=null,token_key_version=null
           where invitation_id=${created.invitation.id}::uuid
             and invitation_revision=1
        `);
      },
    );
    const newTokenDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resendWorkspaceInvitation({
      workspaceId: invitationWorkspace.id,
      actorUserId: ownerUserId,
      invitationId: created.invitation.id,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      tokenDigest: newTokenDigest,
      sealedToken: testSealedToken(),
      deliveryAttemptId: randomUUID(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
    });

    await expect(
      identityDatabase.resolveInvitationAcceptance({
        workspaceId: invitationWorkspace.id,
        invitationId: created.invitation.id,
        tokenDigest: newTokenDigest,
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
    ).resolves.toMatchObject({ status: 'pending', invitationRevision: 2 });
    await expect(
      identityDatabase.readInvitationAcceptance(
        invitationWorkspace.id,
        oldBinding,
      ),
    ).resolves.toMatchObject({ status: 'superseded' });
  });

  it('does not resurrect an abandoned replacement after its successor becomes current', async () => {
    const makeJourney = async (label: string) => {
      const workspace = await identityDatabase.createWorkspaceWithOwner({
        name: `Replacement ${label}`,
        slug: `replacement-${label.toLowerCase()}-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      });
      const tokenDigest = createHash('sha256')
        .update(randomUUID())
        .digest('hex');
      const invitation = await identityDatabase.createWorkspaceInvitation({
        ...invitationCreateCommand(
          workspace.id,
          ownerUserId,
          `${randomUUID()}@example.test`,
        ),
        tokenDigest,
      });
      return { workspace, tokenDigest, invitation: invitation.invitation };
    };
    const a = await makeJourney('A');
    const b = await makeJourney('B');
    const c = await makeJourney('C');
    const d = await makeJourney('D');
    const e = await makeJourney('E');
    const commandA = {
      workspaceId: a.workspace.id,
      invitationId: a.invitation.id,
      tokenDigest: a.tokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    };
    await identityDatabase.resolveInvitationAcceptance(commandA);
    const commandB = {
      workspaceId: b.workspace.id,
      invitationId: b.invitation.id,
      tokenDigest: b.tokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: {
        workspaceId: a.workspace.id,
        intentId: commandA.intentId,
        bindingDigest: commandA.bindingDigest,
      },
    };
    await expect(
      identityDatabase.resolveInvitationAcceptance(commandB),
    ).resolves.toMatchObject({ id: commandB.intentId, status: 'pending' });
    const commandC = {
      workspaceId: c.workspace.id,
      invitationId: c.invitation.id,
      tokenDigest: c.tokenDigest,
      intentId: randomUUID(),
      bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      priorBinding: {
        workspaceId: b.workspace.id,
        intentId: commandB.intentId,
        bindingDigest: commandB.bindingDigest,
      },
    };
    await expect(
      identityDatabase.resolveInvitationAcceptance(commandC),
    ).resolves.toMatchObject({ id: commandC.intentId, status: 'pending' });

    await expect(
      identityDatabase.resolveInvitationAcceptance(commandB),
    ).resolves.toBeNull();
    await expect(
      identityDatabase.resolveInvitationAcceptance({
        workspaceId: d.workspace.id,
        invitationId: d.invitation.id,
        tokenDigest: d.tokenDigest,
        intentId: randomUUID(),
        bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 15 * 60_000),
        priorBinding: commandB.priorBinding,
      }),
    ).resolves.toBeNull();
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('set role pertexo_owner');
      await owner.query(
        'delete from app.workspace_invitation_acceptance_intents where id=$1',
        [commandB.intentId],
      );
    } finally {
      await owner.end();
    }
    await expect(
      identityDatabase.resolveInvitationAcceptance({
        workspaceId: e.workspace.id,
        invitationId: e.invitation.id,
        tokenDigest: e.tokenDigest,
        intentId: randomUUID(),
        bindingDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 15 * 60_000),
        priorBinding: commandB.priorBinding,
      }),
    ).resolves.toBeNull();
    await expect(
      identityDatabase.readInvitationAcceptance(
        c.workspace.id,
        commandC.bindingDigest,
      ),
    ).resolves.toMatchObject({ id: commandC.intentId, status: 'pending' });
    await expect(
      identityDatabase.readInvitationAcceptance(
        b.workspace.id,
        commandB.bindingDigest,
      ),
    ).resolves.toBeNull();
  });
}
