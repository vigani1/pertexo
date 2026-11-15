import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workspaceInvitations as invitations } from '@pertexo/database/schema';
import type { ListWorkspaceInvitationsInput } from '../../tenant-access.types.js';
import { invitationSelection } from './state.repository.js';

/** Newest first after the cursor, one past `limit` so a next page shows. */
export async function readInvitationPage(
  client: PoolClient,
  workspaceId: string,
  input: ListWorkspaceInvitationsInput,
  limit: number,
) {
  const afterId =
    input.after === undefined ? undefined : input.after.invitationId;
  const result = await drizzle(client)
    .select({
      ...invitationSelection,
      created_at_cursor: sql<string>`to_char(${invitations.createdAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(invitations)
    .where(
      and(
        eq(invitations.workspaceId, workspaceId),
        input.after === undefined
          ? undefined
          : sql`(${invitations.createdAt},${invitations.id})<(${input.after.createdAt}::timestamptz,${afterId}::uuid)`,
      ),
    )
    .orderBy(desc(invitations.createdAt), desc(invitations.id))
    .limit(limit + 1)
    .catch(rethrowQueryFailure);
  return result;
}
