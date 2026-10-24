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
  const lock = locking ? 'for share' : '';
  const workspace = await client.query(
    `select 1 from app.workspaces where id=$1 and status=any($2::text[]) ${lock}`,
    [workspaceId, [...allowedStatuses]],
  );
  if (workspace.rowCount !== 1)
    throw new WorkspaceAccessDeniedError('Workspace access is unavailable');
  const actor = await client.query(
    `select 1 from app.users where id=$1 and status='active' ${lock}`,
    [actorId],
  );
  if (actor.rowCount !== 1)
    throw new WorkspaceAccessDeniedError('Workspace access is unavailable');
  const membership = await client.query<{ role: Role }>(
    `select role from app.workspace_memberships
     where workspace_id=$1 and user_id=$2 and status='active'
       and role=any($3::text[]) ${lock}`,
    [workspaceId, actorId, [...roles]],
  );
  const role = membership.rows[0]?.role;
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
