import {
  lockWorkspaceAuthorityInStatuses,
  lockWorkspaceRow,
  readWorkspaceAuthority,
} from './authority.queries.js';
import {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '@pertexo/database/primitives';
import {
  rolesForCapability,
  type AuthorizationCapability,
  type Role,
  type WorkspaceStatusList,
} from '@pertexo/workflow-model';
import type { Pool, PoolClient } from 'pg';

/** Who is acting, where, and what can call the work off. */
export type WorkspaceActor = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;

export type WorkspaceAccess = Readonly<{
  /**
   * `read` runs in one repeatable-read snapshot. `change` takes share locks on
   * the workspace, actor and membership, so authority can't be lost before the
   * change commits. `exclusive` is a change that first takes the workspace row
   * for update: a flow that updates that row, or that runs one at a time per
   * workspace. Taking it after the share lock would let two of them deadlock,
   * each holding the share lock and waiting for the other's update.
   */
  mode: 'read' | 'change' | 'exclusive';
  capability: AuthorizationCapability;
  statuses: WorkspaceStatusList;
}>;

/**
 * Opens the transaction, installs the workspace scope, checks authority inside
 * it and honours the signal. The API's guards are only a first check; this one
 * decides. Fields are picked out of the actor so that a larger input, such as
 * a request body, can't reach the transaction's options. The operation gets the
 * role this check found, so it never has to read the role again with a second
 * status list.
 */
export function withWorkspaceAccess<T>(
  pool: Pool,
  { workspaceId, actorId, signal }: WorkspaceActor,
  { mode, capability, statuses }: WorkspaceAccess,
  operation: (client: PoolClient, role: Role) => Promise<T>,
): Promise<T> {
  const scope = { workspaceId, actorId };
  const options = signal === undefined ? {} : { signal };
  const roles = rolesForCapability(capability);
  if (mode === 'read')
    return withTenantScopedReadClient(
      pool,
      scope,
      async (client) => {
        const role = await readWorkspaceAuthority(client, workspaceId, {
          actorId,
          roles,
          allowedStatuses: statuses,
        });
        return operation(client, role);
      },
      options,
    );
  return withTenantScopedClient(
    pool,
    scope,
    async (client) => {
      if (mode === 'exclusive') await lockWorkspaceRow(client, workspaceId);
      const role = await lockWorkspaceAuthorityInStatuses(client, workspaceId, {
        actorId,
        roles,
        allowedStatuses: statuses,
      });
      return operation(client, role);
    },
    options,
  );
}
