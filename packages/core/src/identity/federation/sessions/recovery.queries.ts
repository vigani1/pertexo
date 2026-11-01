import { and, eq, exists, isNotNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  authAccounts,
  users,
  workspaceMemberships,
  authOrganizations,
  authDomains,
} from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  withActorDiscoveryScope,
} from '@pertexo/database/primitives';
/** The existing discovery fence reads this user's ownership, never another workspace's members. */
export async function isProtectedRecoveryOwner(
  client: PoolClient,
  userId: string,
): Promise<boolean> {
  return withActorDiscoveryScope(client, userId, async (scoped) => {
    const db = drizzle(scoped);
    const rows = await db
      .select({ one: sql`1` })
      .from(workspaceMemberships)
      .innerJoin(
        authOrganizations,
        eq(
          authOrganizations.controlWorkspaceId,
          workspaceMemberships.workspaceId,
        ),
      )
      .where(
        and(
          eq(workspaceMemberships.userId, userId),
          eq(workspaceMemberships.role, 'owner'),
          eq(workspaceMemberships.status, 'active'),
          exists(
            db
              .select({ one: sql`1` })
              .from(authDomains)
              .where(
                and(
                  eq(authDomains.organizationId, authOrganizations.id),
                  eq(authDomains.requireSso, true),
                ),
              ),
          ),
        ),
      )
      .limit(1)
      .catch(rethrowQueryFailure);
    return rows.length === 1;
  });
}
/** Called under the normal workspace/user locks before transferring recovery authority. */
export async function canTransferRecoveryOwnership(
  client: PoolClient,
  workspaceId: string,
  targetUserId: string,
): Promise<boolean> {
  const db = drizzle(client);
  const required = await db
    .select({ one: sql`1` })
    .from(authOrganizations)
    .innerJoin(
      authDomains,
      and(
        eq(authDomains.organizationId, authOrganizations.id),
        eq(authDomains.requireSso, true),
      ),
    )
    .where(eq(authOrganizations.controlWorkspaceId, workspaceId))
    .limit(1)
    .catch(rethrowQueryFailure);
  if (required.length !== 1) return true;
  const candidates = await db
    .select({ one: sql`1` })
    .from(users)
    .innerJoin(
      authAccounts,
      and(
        eq(authAccounts.userId, users.id),
        eq(authAccounts.providerId, 'credential'),
      ),
    )
    .where(
      and(
        eq(users.id, targetUserId),
        eq(users.status, 'active'),
        eq(users.emailVerified, true),
        isNotNull(authAccounts.password),
        sql`length(${authAccounts.password})>0`,
      ),
    )
    .catch(rethrowQueryFailure);
  return candidates.length === 1;
}
