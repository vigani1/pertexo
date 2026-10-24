import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workspaceInvitationDeliveryAttempts as attempts } from '../../schema/foundation.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { PoolClient } from 'pg';

/**
 * Stops every unresolved delivery attempt of one invitation and scrubs its
 * sealed token. Queued and failed attempts become canceled; an attempt whose
 * provider outcome is unknown keeps that status for reconciliation but can no
 * longer be delivered because its token is gone.
 */
export async function cancelOpenInvitationDeliveries(
  client: PoolClient,
  workspaceId: string,
  invitationId: string,
): Promise<void> {
  await drizzle(client)
    .update(attempts)
    .set({
      status: sql`case when ${attempts.status} in ('queued','failed') then 'canceled' else ${attempts.status} end`,
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
        inArray(attempts.status, ['queued', 'failed', 'unknown']),
      ),
    )
    .catch(rethrowQueryFailure);
}
