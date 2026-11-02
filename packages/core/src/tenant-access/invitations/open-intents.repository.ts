import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workspaceInvitationAcceptanceIntents as intents } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

/** An acceptance still in progress: what ending an invitation has to retire. */
export const OPEN_INTENT_STATUSES = Object.freeze([
  'pending',
  'verified',
  'wrong_account',
] as const);

export async function supersedeOpenIntents(
  client: PoolClient,
  workspaceId: string,
  invitationId: string,
): Promise<void> {
  await drizzle(client)
    .update(intents)
    .set({ status: 'superseded', updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(intents.workspaceId, workspaceId),
        eq(intents.invitationId, invitationId),
        inArray(intents.status, OPEN_INTENT_STATUSES),
      ),
    )
    .catch(rethrowQueryFailure);
}
