import { and, eq, exists, inArray, isNotNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workspaceInvitationDeliveryAttempts as attempts,
  workspaceInvitations as invitations,
  workspaces,
  inboxReceipts,
  outboxEvents,
} from '@pertexo/database/schema';
import { lockDeliveryScope } from './authority.queries.js';
import type { WorkspaceInvitationDeliveryStore } from './contract.js';
import { assertInvitationDeliveryIdentity } from './identity.queries.js';
import { sealedToken } from '../input.js';
import { DELIVERY_CONSUMER } from '../../../outbox/delivery-consumers.js';

import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';

import type { Pool, PoolClient } from 'pg';

import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';

/** Off withWorkspaceAccess: the worker delivers it, with no member behind it. */
export function createWorkspaceInvitationDeliveryStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkspaceInvitationDeliveryStore {
  const lease = acquireDatabasePool(config, runtime, { role: 'worker' });

  return Object.freeze({
    claim: (raw: Parameters<WorkspaceInvitationDeliveryStore['claim']>[0]) =>
      claimInvitationDelivery(lease.pool, raw),
    markDispatching: (
      raw: Parameters<WorkspaceInvitationDeliveryStore['markDispatching']>[0],
    ) => markInvitationDeliveryDispatching(lease.pool, raw),
    retry: (raw: Parameters<WorkspaceInvitationDeliveryStore['retry']>[0]) =>
      retryInvitationDelivery(lease.pool, raw),
    complete: (
      raw: Parameters<WorkspaceInvitationDeliveryStore['complete']>[0],
    ) => completeInvitationDelivery(lease.pool, raw),
    confirm: (
      raw: Parameters<WorkspaceInvitationDeliveryStore['confirm']>[0],
    ) => confirmInvitationDelivery(lease.pool, raw),
    close: () => lease.close(),
  });
}

function transaction<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal | undefined,
  operation: (client: PoolClient) => Promise<T>,
) {
  return withTenantScopedClient(
    pool,
    { workspaceId },
    operation,
    signal === undefined ? {} : { signal },
  );
}
async function claimInvitationDelivery(
  pool: Pool,
  raw: Parameters<WorkspaceInvitationDeliveryStore['claim']>[0],
): ReturnType<WorkspaceInvitationDeliveryStore['claim']> {
  const workspaceId = raw.workspaceId;
  const invitationId = raw.invitationId;
  const deliveryAttemptId = raw.deliveryAttemptId;
  const outboxEventId = raw.outboxEventId;
  return transaction(pool, workspaceId, raw.signal, async (client) => {
    await assertInvitationDeliveryIdentity(client, {
      workspaceId,
      invitationId,
      outboxEventId,
    });
    await lockDeliveryScope(
      client,
      workspaceId,
      invitationId,
      deliveryAttemptId,
    );
    const db = drizzle(client);
    const result = await db
      .select({
        attempt_status: attempts.status,
        invitation_revision: attempts.invitationRevision,
        ciphertext: attempts.tokenCiphertext,
        nonce: attempts.tokenNonce,
        tag: attempts.tokenTag,
        key_version: attempts.tokenKeyVersion,
        invitation_status: invitations.status,
        current_revision: invitations.revision,
        recipient_email: invitations.recipientEmail,
        role: invitations.role,
        expires_at: invitations.expiresAt,
        expired: sql<boolean>`${invitations.expiresAt}<=clock_timestamp()`,
        workspace_name: attempts.workspaceName,
        workspace_status: workspaces.status,
      })
      .from(attempts)
      .innerJoin(
        invitations,
        and(
          eq(invitations.workspaceId, attempts.workspaceId),
          eq(invitations.id, attempts.invitationId),
        ),
      )
      .innerJoin(workspaces, eq(workspaces.id, attempts.workspaceId))
      .where(
        and(
          eq(attempts.workspaceId, workspaceId),
          eq(attempts.id, deliveryAttemptId),
          eq(attempts.invitationId, invitationId),
        ),
      )
      .catch(rethrowQueryFailure);
    const row = result[0];
    if (row === undefined)
      throw new Error('Workspace invitation delivery is unavailable');
    const invitationUnavailable =
      row.workspace_status !== 'active' ||
      row.invitation_status !== 'pending' ||
      row.invitation_revision !== row.current_revision ||
      row.expired ||
      ['submitted', 'failed', 'canceled'].includes(row.attempt_status);
    if (invitationUnavailable) {
      if (!['submitted', 'failed', 'canceled'].includes(row.attempt_status))
        await db
          .update(attempts)
          .set({
            status: sql`case when ${attempts.status}='queued' then 'canceled' else ${attempts.status} end`,
            tokenCiphertext: null,
            tokenNonce: null,
            tokenTag: null,
            tokenKeyVersion: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(attempts.workspaceId, workspaceId),
              eq(attempts.id, deliveryAttemptId),
              eq(attempts.invitationId, invitationId),
              inArray(attempts.status, ['queued', 'unknown']),
            ),
          )
          .catch(rethrowQueryFailure);
      const mustExpireInvitation =
        row.invitation_status === 'pending' &&
        (row.expired || row.workspace_status !== 'active');
      if (mustExpireInvitation)
        await db
          .update(invitations)
          .set({
            deliveryStatus: 'canceled',
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(invitations.workspaceId, workspaceId),
              eq(invitations.id, invitationId),
              eq(invitations.deliveryStatus, 'queued'),
            ),
          )
          .catch(rethrowQueryFailure);
      return Object.freeze({ kind: 'terminal' as const });
    }
    const attemptUnavailable =
      !['queued', 'unknown'].includes(row.attempt_status) ||
      row.ciphertext === null ||
      row.nonce === null ||
      row.tag === null ||
      row.key_version === null;
    if (attemptUnavailable)
      throw new Error('Workspace invitation delivery state is invalid');
    return Object.freeze({
      kind: 'ready' as const,
      recoveredUnknown: row.attempt_status === 'unknown',
      email: row.recipient_email,
      workspaceName: row.workspace_name,
      role: row.role,
      expiresAt: row.expires_at,
      sealedToken: sealedToken.parse({
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        tag: row.tag,
        keyVersion: row.key_version,
      }),
    });
  });
}

async function confirmInvitationDelivery(
  pool: Pool,
  raw: Parameters<WorkspaceInvitationDeliveryStore['confirm']>[0],
): ReturnType<WorkspaceInvitationDeliveryStore['confirm']> {
  await transaction(pool, raw.workspaceId, raw.signal, async (client) => {
    await drizzle(client)
      .execute(
        sql`insert into ${inboxReceipts}
              (consumer_name, message_id, workspace_id, payload_checksum, completed_at)
            select ${DELIVERY_CONSUMER['deliver-workspace-invitation']}, id, workspace_id, payload_checksum, clock_timestamp()
              from ${outboxEvents}
             where workspace_id = ${raw.workspaceId} and id = ${raw.outboxEventId}
            on conflict do nothing`,
      )
      .catch(rethrowQueryFailure);
  });
}

async function markInvitationDeliveryDispatching(
  pool: Pool,
  raw: Parameters<WorkspaceInvitationDeliveryStore['markDispatching']>[0],
): ReturnType<WorkspaceInvitationDeliveryStore['markDispatching']> {
  const workspaceId = raw.workspaceId;
  return transaction(pool, workspaceId, raw.signal, async (client) => {
    const invitationId = raw.invitationId;
    const deliveryAttemptId = raw.deliveryAttemptId;
    await lockDeliveryScope(
      client,
      workspaceId,
      invitationId,
      deliveryAttemptId,
    );
    const result = await drizzle(client)
      .update(attempts)
      .set({ status: 'unknown', updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(attempts.workspaceId, workspaceId),
          eq(attempts.invitationId, invitationId),
          eq(attempts.id, deliveryAttemptId),
          eq(attempts.status, raw.recoveredUnknown ? 'unknown' : 'queued'),
        ),
      )
      .returning({ id: attempts.id })
      .catch(rethrowQueryFailure);
    return result.length === 1;
  });
}

async function retryInvitationDelivery(
  pool: Pool,
  raw: Parameters<WorkspaceInvitationDeliveryStore['retry']>[0],
): ReturnType<WorkspaceInvitationDeliveryStore['retry']> {
  const workspaceId = raw.workspaceId;
  const invitationId = raw.invitationId;
  const deliveryAttemptId = raw.deliveryAttemptId;
  return transaction(pool, workspaceId, raw.signal, async (client) => {
    await lockDeliveryScope(
      client,
      workspaceId,
      invitationId,
      deliveryAttemptId,
    );
    const db = drizzle(client);
    const activeInvitation = db
      .select({ one: sql`1` })
      .from(invitations)
      .innerJoin(workspaces, eq(workspaces.id, attempts.workspaceId))
      .where(
        and(
          eq(invitations.workspaceId, attempts.workspaceId),
          eq(invitations.id, attempts.invitationId),
          eq(invitations.status, 'pending'),
          sql`${invitations.expiresAt}>clock_timestamp()`,
          eq(invitations.revision, attempts.invitationRevision),
          eq(workspaces.status, 'active'),
        ),
      );
    const result = await db
      .update(attempts)
      .set({ status: 'queued', updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(attempts.workspaceId, workspaceId),
          eq(attempts.invitationId, invitationId),
          eq(attempts.id, deliveryAttemptId),
          inArray(attempts.status, ['queued', 'unknown']),
          isNotNull(attempts.tokenCiphertext),
          exists(activeInvitation),
        ),
      )
      .returning({ id: attempts.id })
      .catch(rethrowQueryFailure);
    return result.length === 1;
  });
}

async function completeInvitationDelivery(
  pool: Pool,
  raw: Parameters<WorkspaceInvitationDeliveryStore['complete']>[0],
): ReturnType<WorkspaceInvitationDeliveryStore['complete']> {
  const workspaceId = raw.workspaceId;
  await transaction(pool, workspaceId, raw.signal, async (client) => {
    const invitationId = raw.invitationId;
    const deliveryAttemptId = raw.deliveryAttemptId;
    await lockDeliveryScope(
      client,
      workspaceId,
      invitationId,
      deliveryAttemptId,
    );
    const db = drizzle(client);
    const completed = await db
      .update(attempts)
      .set({
        status: raw.status,
        providerReference: raw.providerReference ?? null,
        failureCode: raw.failureCode ?? null,
        tokenCiphertext: null,
        tokenNonce: null,
        tokenTag: null,
        tokenKeyVersion: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(attempts.workspaceId, workspaceId),
          eq(attempts.invitationId, invitationId),
          eq(attempts.id, deliveryAttemptId),
          inArray(attempts.status, ['queued', 'unknown']),
        ),
      )
      .returning({ id: attempts.id })
      .catch(rethrowQueryFailure);
    if (completed.length !== 1) return;
    const currentAttempt = db
      .select({ one: sql`1` })
      .from(attempts)
      .where(
        and(
          eq(attempts.workspaceId, workspaceId),
          eq(attempts.id, deliveryAttemptId),
          eq(attempts.invitationId, invitationId),
          eq(attempts.invitationRevision, invitations.revision),
        ),
      );
    await db
      .update(invitations)
      .set({ deliveryStatus: raw.status, updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(invitations.workspaceId, workspaceId),
          eq(invitations.id, invitationId),
          eq(invitations.status, 'pending'),
          exists(currentAttempt),
        ),
      )
      .catch(rethrowQueryFailure);
  });
}
