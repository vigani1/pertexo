import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { expect, it } from 'vitest';

import { IdempotencyConflictError } from '../../../../../src/platform/idempotency/repository.js';

import {
  adminDatabaseUrl,
  identityDatabase,
  tenantDatabase,
  ownerUserId,
  testSealedToken,
  invitationTokenDigest,
  invitationCreateCommand,
} from '../../fixture.js';

export function registerBindsInvitationSCommandTarget(): void {
  it.each(['resend', 'revoke'] as const)(
    'binds an invitation %s command to its target',
    async (operation) => {
      const workspace = await identityDatabase.createWorkspaceWithOwner({
        name: 'Invitation targets',
        slug: `invite-target-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      });
      const first = await identityDatabase.createWorkspaceInvitation(
        invitationCreateCommand(
          workspace.id,
          ownerUserId,
          `${randomUUID()}@example.test`,
        ),
      );
      const second = await identityDatabase.createWorkspaceInvitation(
        invitationCreateCommand(
          workspace.id,
          ownerUserId,
          `${randomUUID()}@example.test`,
        ),
      );
      const command = {
        workspaceId: workspace.id,
        actorUserId: ownerUserId,
        invitationId: first.invitation.id,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        tokenDigest: invitationTokenDigest(randomUUID()),
        sealedToken: testSealedToken(),
        deliveryAttemptId: randomUUID(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      };
      if (operation === 'resend')
        await tenantDatabase.withWorkspace(workspace.id, async ({ db }) => {
          await db.execute(sql`update app.workspace_invitation_delivery_attempts
        set status='failed',token_ciphertext=null,token_nonce=null,token_tag=null,token_key_version=null
        where invitation_id in (${first.invitation.id}::uuid,${second.invitation.id}::uuid)`);
        });
      const method =
        operation === 'resend'
          ? 'resendWorkspaceInvitation'
          : 'revokeWorkspaceInvitation';
      const changed = await identityDatabase[method](command);
      expect(changed.replayed).toBe(false);
      expect(changed.invitation.id).toBe(first.invitation.id);
      const replayed = await identityDatabase[method](command);
      expect(replayed.replayed).toBe(true);
      expect(replayed.invitation.id).toBe(first.invitation.id);
      await expect(
        identityDatabase[method]({
          ...command,
          invitationId: second.invitation.id,
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    },
  );

  it('creates one pending invitation, replays exactly, and arbitrates concurrent duplicates', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        id: '00000000-0000-4000-8000-000000000002',
        name: 'Invitation creation',
        slug: `invite-create-${randomUUID().slice(0, 8)}`,
        ownerUserId,
      },
    );
    const command = invitationCreateCommand(
      invitationWorkspace.id,
      ownerUserId,
      'hash-golden@example.test',
    );
    const first = await identityDatabase.createWorkspaceInvitation({
      ...command,
      invitationId: '00000000-0000-4000-8000-000000000006',
      deliveryAttemptId: '00000000-0000-4000-8000-000000000007',
    });
    const inspection = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
    try {
      const stored = await inspection.query<{
        outbox_id: string;
        payload_checksum: string;
        delivery_attempt_id: string;
      }>(
        `select outbox.id outbox_id,outbox.payload_checksum,
                outbox.payload->>'deliveryAttemptId' delivery_attempt_id
           from app.idempotency_records command
           join app.outbox_events outbox
             on outbox.aggregate_id=command.resource_id
            and outbox.workspace_id=command.workspace_id
          where command.workspace_id=$1 and command.scope=$2::text
            and command.operation='workspace.invitation.create'
            and command.resource_id=$3 and command.key_hash=$4`,
        [
          invitationWorkspace.id,
          ownerUserId,
          first.invitation.id,
          createHash('sha256').update(command.idempotencyKey).digest('hex'),
        ],
      );
      expect(stored.rows).toHaveLength(1);
      const row = stored.rows[0];
      if (row === undefined) throw new Error('Expected invitation evidence');
      expect(row.delivery_attempt_id).toBe(
        '00000000-0000-4000-8000-000000000007',
      );
      const outboxBytes = `{"deliveryAttemptId":"${row.delivery_attempt_id}","invitationId":"${first.invitation.id}","outboxEventId":"${row.outbox_id}","workspaceId":"${invitationWorkspace.id}"}`;
      expect(row.payload_checksum).toBe(
        createHash('sha256').update(outboxBytes).digest('hex'),
      );
    } finally {
      await inspection.end();
    }
    await expect(
      identityDatabase.createWorkspaceInvitation(command),
    ).resolves.toMatchObject({
      replayed: true,
      invitation: { id: first.invitation.id },
    });
    await expect(
      identityDatabase.createWorkspaceInvitation({
        ...command,
        role: 'builder',
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const email = `${randomUUID()}@example.test`;
    const results = await Promise.allSettled([
      identityDatabase.createWorkspaceInvitation(
        invitationCreateCommand(invitationWorkspace.id, ownerUserId, email),
      ),
      identityDatabase.createWorkspaceInvitation(
        invitationCreateCommand(invitationWorkspace.id, ownerUserId, email),
      ),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const page = await identityDatabase.listWorkspaceInvitations(
      invitationWorkspace.id,
      ownerUserId,
    );
    expect(page.items.filter((item) => item.email === email)).toHaveLength(1);
  });

  it('lists members and invitations side by side without a lock cycle', async () => {
    // The Team page reads both at once; each read must succeed however the
    // two interleave, and while an invitation is being created.
    const teamWorkspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Concurrent team reads',
      slug: `team-reads-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const reads = Array.from({ length: 24 }, (_, index) =>
      index % 2 === 0
        ? identityDatabase.listWorkspaceMembers(teamWorkspace.id, ownerUserId)
        : identityDatabase.listWorkspaceInvitations(
            teamWorkspace.id,
            ownerUserId,
          ),
    );
    const created = identityDatabase.createWorkspaceInvitation(
      invitationCreateCommand(
        teamWorkspace.id,
        ownerUserId,
        `${randomUUID()}@example.test`,
      ),
    );
    const settled = await Promise.allSettled([...reads, created]);
    expect(settled.filter((outcome) => outcome.status === 'rejected')).toEqual(
      [],
    );
  });
}
