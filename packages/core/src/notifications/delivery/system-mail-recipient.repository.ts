import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  users,
  workspaceMemberships,
  workspaces,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

/** The addressed member's account, independent of personal mail preferences. */
export async function readSystemMailRecipient(
  db: Pick<NodePgDatabase, 'select'>,
  workspaceId: string,
  memberId: string,
) {
  const [row] = await db
    .select({ email: users.email, verified: users.emailVerified })
    .from(workspaceMemberships)
    .innerJoin(users, eq(users.id, workspaceMemberships.userId))
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, memberId),
        eq(workspaceMemberships.status, 'active'),
        eq(users.status, 'active'),
        eq(workspaces.status, 'active'),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  return row;
}
