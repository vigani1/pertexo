import { and, desc, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { authDirectoryUsers } from '../../../schema/identity/federation/directory/users.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { PoolClient } from 'pg';

export async function directorySessionAllowed(
  client: PoolClient,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const rows = await drizzle(client)
    .select({
      active: authDirectoryUsers.active,
      deleted_at: authDirectoryUsers.deletedAt,
    })
    .from(authDirectoryUsers)
    .where(
      and(
        eq(authDirectoryUsers.organizationId, organizationId),
        eq(authDirectoryUsers.userId, userId),
      ),
    )
    .orderBy(
      desc(isNull(authDirectoryUsers.deletedAt)),
      desc(authDirectoryUsers.createdAt),
      desc(authDirectoryUsers.id),
    )
    .limit(1)
    .catch(rethrowQueryFailure);
  const current = rows[0];
  return (
    current === undefined || (current.active && current.deleted_at === null)
  );
}
