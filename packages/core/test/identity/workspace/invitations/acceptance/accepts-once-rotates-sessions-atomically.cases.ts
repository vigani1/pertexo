import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { expect, it } from 'vitest';

import { IdempotencyConflictError } from '@pertexo/database/platform';

import {
  adminDatabaseUrl,
  identityDatabase,
  tenantDatabase,
  ownerUserId,
  createAuthenticationSession,
  findActiveAuthenticationSession,
  invitationCreateCommand,
  createInvitationProofSession,
} from '../../fixture.js';

export function registerAcceptsOnceRotatesSessionsAtomically(): void {
  it('accepts once, rotates sessions atomically, and replays the historical receipt', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        id: '00000000-0000-4000-8000-000000000003',
        name: 'Invitation acceptance',
        slug: `invite-accept-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const recipient = await identityDatabase.createUser({
      id: '00000000-0000-4000-8000-000000000004',
      email: `${randomUUID()}@example.test`,
      displayName: 'Invited recipient',
    });
    const tokenDigest = createHash('sha256')
      .update('accept-secret')
      .digest('hex');
    const created = await identityDatabase.createWorkspaceInvitation({
      ...invitationCreateCommand(
        invitationWorkspace.id,
        ownerUserId,
        recipient.email,
      ),
      tokenDigest,
    });
    const intentId = '00000000-0000-4000-8000-000000000005';
    const bindingDigest = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    await identityDatabase.resolveInvitationAcceptance({
      workspaceId: invitationWorkspace.id,
      invitationId: created.invitation.id,
      tokenDigest,
      intentId,
      bindingDigest,
      csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await identityDatabase.recordInvitationAcceptanceProof({
      workspaceId: invitationWorkspace.id,
      intentId,
      bindingDigest,
      userId: recipient.id,
      sessionId: await createInvitationProofSession(recipient.id),
      verifiedEmail: recipient.email,
      verifiedAt: new Date(),
    });
    const oldToken = await createAuthenticationSession(recipient.id);
    const replacementToken = createHash('sha256')
      .update(randomUUID())
      .digest('hex');
    const key = randomUUID();
    const command = {
      workspaceId: invitationWorkspace.id,
      intentId,
      invitationRevision: 1,
      actorUserId: recipient.id,
      idempotencyKey: key,
      replacementSession: {
        id: randomUUID(),
        token: replacementToken,
        expiresAt: new Date(Date.now() + 60_000),
      },
    };
    await expect(
      identityDatabase.completeInvitationAcceptance(command),
    ).resolves.toMatchObject({ membershipCreated: true, replayed: false });
    const inspection = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
    try {
      const accepted = await inspection.query<{ resource_id: string }>(
        `select resource_id from app.idempotency_records
          where workspace_id=$1 and scope=$2::text
            and operation='workspace.invitation.accept' and key_hash=$3`,
        [
          invitationWorkspace.id,
          recipient.id,
          createHash('sha256').update(key).digest('hex'),
        ],
      );
      expect(accepted.rows).toEqual([{ resource_id: intentId }]);
    } finally {
      await inspection.end();
    }
    await expect(findActiveAuthenticationSession(oldToken)).resolves.toBeNull();
    await expect(
      findActiveAuthenticationSession(replacementToken),
    ).resolves.toEqual({ user_id: recipient.id });
    await expect(
      identityDatabase.recordInvitationAcceptanceProof({
        workspaceId: invitationWorkspace.id,
        intentId,
        bindingDigest,
        userId: recipient.id,
        sessionId: await createInvitationProofSession(recipient.id),
        verifiedEmail: recipient.email,
        verifiedAt: new Date(),
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      acceptedUserId: recipient.id,
    });
    await expect(
      identityDatabase.completeInvitationAcceptance(command),
    ).resolves.toMatchObject({ membershipCreated: true, replayed: true });
    await expect(
      identityDatabase.completeInvitationAcceptance({
        ...command,
        invitationRevision: 2,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      identityDatabase.completeInvitationAcceptance({
        ...command,
        invitationRevision: 2,
        idempotencyKey: randomUUID(),
      }),
    ).resolves.toMatchObject({ membershipCreated: true, replayed: true });
    await expect(
      identityDatabase.findWorkspaceAccess(
        recipient.id,
        invitationWorkspace.id,
      ),
    ).resolves.toMatchObject({ role: 'viewer', membershipStatus: 'active' });
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        const added = await db.execute(sql`
        select actor_user_id,target_type,target_id,metadata from app.audit_events
        where action='workspace.member_added' and target_id=${recipient.id}::uuid
      `);
        expect(added.rows).toEqual([
          {
            actor_user_id: recipient.id,
            target_type: 'workspace_member',
            target_id: recipient.id,
            metadata: {
              source: 'invitation',
              invitationId: created.invitation.id,
              role: 'viewer',
              status: 'active',
              roleRevision: 1,
            },
          },
        ]);
      },
    );
  });
}
