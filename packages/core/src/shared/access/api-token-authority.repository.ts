import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  apiTokens,
  users,
  workspaces,
  workspaceMemberships,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

export async function readApiTokenAuthority(
  db: Pick<NodePgDatabase, 'select'>,
  input: Readonly<{ workspaceId: string; tokenId: string }>,
) {
  const [row] = await db
    .select({
      ...getTableColumns(apiTokens),
      ownerStatus: users.status,
      memberStatus: workspaceMemberships.status,
      workspaceStatus: workspaces.status,
      currentRevision: workspaceMemberships.roleRevision,
      observedAt: sql<Date>`clock_timestamp()`.mapWith(apiTokens.createdAt),
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.ownerUserId))
    .innerJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, apiTokens.workspaceId),
        eq(workspaceMemberships.userId, apiTokens.ownerUserId),
      ),
    )
    .innerJoin(workspaces, eq(workspaces.id, apiTokens.workspaceId))
    .where(
      and(
        eq(apiTokens.workspaceId, input.workspaceId),
        eq(apiTokens.id, input.tokenId),
      ),
    )
    .catch(rethrowQueryFailure);
  return row;
}
