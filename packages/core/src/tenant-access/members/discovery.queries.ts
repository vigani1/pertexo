import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { users, workspaceMemberships } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

const PAGE_SIZE = 50;

/** Names-only directory; the caller owns its workspace and capability fence. */
export async function readWorkspacePeople(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    after?: string | undefined;
    q: string;
  }>,
) {
  const after = input.after ?? null;
  const rows = await drizzle(client)
    .select({
      userId: workspaceMemberships.userId,
      displayName: users.displayName,
      role: workspaceMemberships.role,
    })
    .from(workspaceMemberships)
    .innerJoin(
      users,
      and(
        eq(users.id, workspaceMemberships.userId),
        eq(users.status, 'active'),
      ),
    )
    .where(
      and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        eq(workspaceMemberships.status, 'active'),
        after === null ? undefined : gt(workspaceMemberships.userId, after),
        sql`position(lower(${input.q}) in lower(${users.displayName}))>0`,
      ),
    )
    .orderBy(asc(workspaceMemberships.userId))
    .limit(PAGE_SIZE + 1)
    .catch(rethrowQueryFailure);
  const page = rows.slice(0, PAGE_SIZE);
  return {
    items: page,
    nextCursor: rows.length > PAGE_SIZE ? (page.at(-1)?.userId ?? null) : null,
  };
}
