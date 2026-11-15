import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workspaces,
  users,
  workspaceMemberships,
} from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  type WorkspaceTransaction,
} from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { ACTIVE_WORKSPACE_STATUSES, type Role } from '@pertexo/policy';
import type { ResourceActor } from './folder-access.types.js';

/**
 * Ordered current authority fence shared by workspace commands: the workspace,
 * then the actor, then the membership, stopping at the first that's missing.
 * Undefined means no authority. Call only inside the same tenant transaction as
 * the protected work.
 */
export async function findWorkspaceAuthority(
  client: PoolClient,
  workspaceId: string,
  {
    actorId,
    roles,
    locking,
    allowedStatuses = ACTIVE_WORKSPACE_STATUSES,
  }: Readonly<{
    actorId: string;
    roles: readonly Role[];
    locking: boolean;
    allowedStatuses?: readonly string[] | undefined;
  }>,
): Promise<Role | undefined> {
  const db = drizzle(client);
  const workspaceQuery = db
    .select({ one: sql`1` })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, workspaceId),
        sql`${workspaces.status}=any(${sql.param(allowedStatuses)}::text[])`,
      ),
    );
  const workspace = await (
    locking ? workspaceQuery.for('share') : workspaceQuery
  ).catch(rethrowQueryFailure);
  if (workspace.length !== 1) return undefined;
  const actorQuery = db
    .select({ one: sql`1` })
    .from(users)
    .where(and(eq(users.id, actorId), eq(users.status, 'active')));
  const actor = await (locking ? actorQuery.for('share') : actorQuery).catch(
    rethrowQueryFailure,
  );
  if (actor.length !== 1) return undefined;
  const memberQuery = db
    .select({ role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, actorId),
        eq(workspaceMemberships.status, 'active'),
        sql`${workspaceMemberships.role}=any(${sql.param(roles)}::text[])`,
      ),
    );
  const membership = await (
    locking ? memberQuery.for('share') : memberQuery
  ).catch(rethrowQueryFailure);
  return membership[0]?.role;
}

/**
 * Runs flows on one workspace one at a time. Take it before any share lock on the
 * row. Returns the status it locked, or undefined for a workspace this scope can't see.
 */
export async function lockWorkspaceRow(
  client: PoolClient,
  workspaceId: string,
): Promise<string | undefined> {
  const rows = await drizzle(client)
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for('update')
    .catch(rethrowQueryFailure);
  return rows[0]?.status;
}

/**
 * The actor's role, or null if the actor has none here. For a read that answers
 * someone without access with nothing rather than a denial, so it refuses no one.
 */
export async function readWorkspaceRole(
  db: WorkspaceTransaction['db'],
  actor: ResourceActor,
  workspaceStatuses: readonly string[],
): Promise<Role | null> {
  const rows = await db
    .select({ role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .innerJoin(users, eq(users.id, workspaceMemberships.userId))
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, actor.workspaceId),
        eq(workspaceMemberships.userId, actor.actorId),
        eq(workspaceMemberships.status, 'active'),
        eq(users.status, 'active'),
        sql`${workspaces.status}=any(${sql.param(workspaceStatuses)}::text[])`,
      ),
    )
    .catch(rethrowQueryFailure);
  return rows[0]?.role ?? null;
}
