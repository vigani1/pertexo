import type { PoolClient } from 'pg';
import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  type Role,
} from '@pertexo/policy';
import { findWorkspaceAuthority } from './authority.repository.js';
import { WorkspaceAccessDeniedError } from './workspace-access.errors.js';

export function lockWorkspaceAuthority(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  roles: readonly Role[],
): Promise<Role> {
  return requireAuthority(client, workspaceId, {
    actorId,
    roles,
    locking: true,
  });
}

/** The fence for core's one authority helper, which names its status list. */
export function lockWorkspaceAuthorityInStatuses(
  client: PoolClient,
  workspaceId: string,
  {
    actorId,
    roles,
    allowedStatuses,
  }: Readonly<{
    actorId: string;
    roles: readonly Role[];
    allowedStatuses: readonly string[];
  }>,
): Promise<Role> {
  return requireAuthority(client, workspaceId, {
    actorId,
    roles,
    locking: true,
    allowedStatuses,
  });
}

/** The same fence for a read a suspended workspace still allows (ADR 013/027). */
export function lockBrowsableWorkspaceAuthority(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  roles: readonly Role[],
): Promise<Role> {
  return requireAuthority(client, workspaceId, {
    actorId,
    roles,
    locking: true,
    allowedStatuses: BROWSABLE_WORKSPACE_STATUSES,
  });
}

/** The caller owns a repeatable-read snapshot; decision commands use the lock. */
export function readWorkspaceAuthority(
  client: PoolClient,
  workspaceId: string,
  {
    actorId,
    roles,
    allowedStatuses = ACTIVE_WORKSPACE_STATUSES,
  }: Readonly<{
    actorId: string;
    roles: readonly Role[];
    allowedStatuses?: readonly string[] | undefined;
  }>,
): Promise<Role> {
  return requireAuthority(client, workspaceId, {
    actorId,
    roles,
    locking: false,
    allowedStatuses,
  });
}

async function requireAuthority(
  ...args: Parameters<typeof findWorkspaceAuthority>
): Promise<Role> {
  const role = await findWorkspaceAuthority(...args);
  if (role === undefined)
    throw new WorkspaceAccessDeniedError('Workspace access is unavailable');
  return role;
}
