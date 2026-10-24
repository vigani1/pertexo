import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workspaces,
  users,
  workspaceMemberships,
} from '../../schema/foundation.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import type { Role } from '@pertexo/workflow-model';
import { WorkspaceAccessDeniedError } from '../errors.js';

/** Ordered current authority fence shared by workspace commands. Call only inside the same tenant transaction as the protected work. */
async function workspaceAuthority(
  client: PoolClient,
  workspaceId: string,
  {
    actorId,
    roles,
    locking,
    allowedStatuses = ['active'],
  }: Readonly<{
    actorId: string;
    roles: readonly Role[];
    locking: boolean;
    allowedStatuses?: readonly string[] | undefined;
  }>,
): Promise<Role> {
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
  if (workspace.length !== 1)
    throw new WorkspaceAccessDeniedError('Workspace access is unavailable');
  const actorQuery = db
    .select({ one: sql`1` })
    .from(users)
    .where(and(eq(users.id, actorId), eq(users.status, 'active')));
  const actor = await (locking ? actorQuery.for('share') : actorQuery).catch(
    rethrowQueryFailure,
  );
  if (actor.length !== 1)
    throw new WorkspaceAccessDeniedError('Workspace access is unavailable');
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
  const role = membership[0]?.role;
  if (role === undefined)
    throw new WorkspaceAccessDeniedError('Workspace access is unavailable');
  return role;
}

export function lockWorkspaceAuthority(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  roles: readonly Role[],
): Promise<Role> {
  return workspaceAuthority(client, workspaceId, {
    actorId,
    roles,
    locking: true,
  });
}

/** The caller owns a repeatable-read snapshot; decision commands use the lock. */
export function readWorkspaceAuthority(
  client: PoolClient,
  workspaceId: string,
  {
    actorId,
    roles,
    allowedStatuses = ['active'],
  }: Readonly<{
    actorId: string;
    roles: readonly Role[];
    allowedStatuses?: readonly string[] | undefined;
  }>,
): Promise<Role> {
  return workspaceAuthority(client, workspaceId, {
    actorId,
    roles,
    locking: false,
    allowedStatuses,
  });
}
