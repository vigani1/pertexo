import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { expect, it } from 'vitest';
import { parseDatabaseConfig } from '../../../../../src/testing.js';

import { createWorkspaceInvitationDeliveryStore } from '../../../../../src/tenant-access/index.js';

import {
  workerUrl,
  identityDatabase,
  tenantDatabase,
  ownerUserId,
  invitationCreateCommand,
} from '../../fixture.js';

export function registerKeepsInvitationDeliveryRenderingStable(): void {
  it('keeps invitation delivery rendering stable across a workspace rename', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Original delivery name',
        slug: `invite-snapshot-${randomUUID().slice(0, 8)}`,
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
    let deliveryAttemptId = '';
    let outboxEventId = '';
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        const rows = await db.execute<{
          attempt_id: string;
          outbox_id: string;
        }>(sql`
        select attempt.id attempt_id,outbox.id outbox_id
          from app.workspace_invitation_delivery_attempts attempt
          join app.outbox_events outbox
            on outbox.aggregate_id=attempt.invitation_id
           and outbox.payload->>'deliveryAttemptId'=attempt.id::text
         where attempt.invitation_id=${created.invitation.id}::uuid
      `);
        deliveryAttemptId = rows.rows[0]?.attempt_id ?? '';
        outboxEventId = rows.rows[0]?.outbox_id ?? '';
      },
    );
    const deliveryStore = createWorkspaceInvitationDeliveryStore(
      parseDatabaseConfig({ connectionString: workerUrl, max: 1 }),
    );
    try {
      const first = await deliveryStore.claim({
        workspaceId: invitationWorkspace.id,
        invitationId: created.invitation.id,
        deliveryAttemptId,
        outboxEventId,
      });
      await identityDatabase.renameWorkspace({
        workspaceId: invitationWorkspace.id,
        actorUserId: ownerUserId,
        name: 'Renamed after dispatch uncertainty',
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
      const retried = await deliveryStore.claim({
        workspaceId: invitationWorkspace.id,
        invitationId: created.invitation.id,
        deliveryAttemptId,
        outboxEventId,
      });
      expect(first).toMatchObject({
        kind: 'ready',
        workspaceName: 'Original delivery name',
      });
      expect(retried).toMatchObject(first);
      const identity = {
        workspaceId: invitationWorkspace.id,
        invitationId: created.invitation.id,
        deliveryAttemptId,
      };
      expect(first).toMatchObject({ recoveredUnknown: false });
      expect(
        await deliveryStore.markDispatching({
          ...identity,
          recoveredUnknown: false,
        }),
      ).toBe(true);
      // Two copies of one job can both read `queued`; only one of them may send.
      expect(
        await deliveryStore.markDispatching({
          ...identity,
          recoveredUnknown: false,
        }),
      ).toBe(false);
      expect(
        await deliveryStore.claim({ ...identity, outboxEventId }),
      ).toMatchObject({ kind: 'ready', recoveredUnknown: true });
      expect(await deliveryStore.retry(identity)).toBe(true);
      expect(
        await deliveryStore.claim({ ...identity, outboxEventId }),
      ).toMatchObject({ kind: 'ready', recoveredUnknown: false });
      await identityDatabase.revokeWorkspaceInvitation({
        workspaceId: invitationWorkspace.id,
        actorUserId: ownerUserId,
        invitationId: created.invitation.id,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
      expect(await deliveryStore.retry(identity)).toBe(false);
    } finally {
      await deliveryStore.close();
    }
  });

  it('keeps delivery and invitation commands deadlock-free under concurrency', async () => {
    const invitationWorkspace = await identityDatabase.createWorkspaceWithOwner(
      {
        name: 'Invitation lock ordering',
        slug: `invite-locks-${randomUUID().slice(0, 8)}`,
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
    let deliveryAttemptId = '';
    await tenantDatabase.withWorkspace(
      invitationWorkspace.id,
      async ({ db }) => {
        const attempt = await db.execute<{ id: string }>(sql`
          select id from app.workspace_invitation_delivery_attempts
           where invitation_id=${created.invitation.id}::uuid
        `);
        deliveryAttemptId = attempt.rows[0]?.id ?? '';
      },
    );
    const delivery = createWorkspaceInvitationDeliveryStore(
      parseDatabaseConfig({ connectionString: workerUrl, max: 2 }),
    );
    try {
      await delivery.markDispatching({
        workspaceId: invitationWorkspace.id,
        invitationId: created.invitation.id,
        deliveryAttemptId,
        recoveredUnknown: false,
      });
      const concurrent = Promise.allSettled([
        delivery.complete({
          workspaceId: invitationWorkspace.id,
          invitationId: created.invitation.id,
          deliveryAttemptId,
          status: 'submitted',
          providerReference: 'provider-lock-order-proof',
        }),
        identityDatabase.revokeWorkspaceInvitation({
          workspaceId: invitationWorkspace.id,
          actorUserId: ownerUserId,
          invitationId: created.invitation.id,
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
        }),
      ]);
      const outcomes = await Promise.race([
        concurrent,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('invitation lock timeout'));
          }, 5_000);
        }),
      ]);
      expect(outcomes).toHaveLength(2);
      expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(
        true,
      );
      const invitation = await identityDatabase.listWorkspaceInvitations(
        invitationWorkspace.id,
        ownerUserId,
      );
      expect(
        invitation.items.find((item) => item.id === created.invitation.id),
      ).toMatchObject({ status: 'revoked', deliveryStatus: 'canceled' });
      await tenantDatabase.withWorkspace(
        invitationWorkspace.id,
        async ({ db }) => {
          const attempt = await db.execute(sql<{
            provider_reference: string | null;
            status: string;
          }>`
            select provider_reference,status
              from app.workspace_invitation_delivery_attempts
             where id=${deliveryAttemptId}::uuid
          `);
          expect(attempt.rows[0]).toEqual({
            provider_reference: 'provider-lock-order-proof',
            status: 'submitted',
          });
        },
      );
    } finally {
      await delivery.close();
    }
  });
}
