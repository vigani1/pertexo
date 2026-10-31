import {
  lockWorkspaceAuthorityInStatuses,
  readWorkspaceAuthority,
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '@pertexo/database/primitives';
import {
  rolesForCapability,
  type AuthorizationCapability,
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
   * change commits.
   */
  mode: 'read' | 'change';
  capability: AuthorizationCapability;
  statuses: WorkspaceStatusList;
}>;

/**
 * Opens the transaction, installs the workspace scope, checks authority inside
 * it and honours the signal. The API's guards are only a first check; this one
 * decides. Fields are picked out of the actor so that a larger input, such as
 * a request body, can't reach the transaction's options.
 */
export function withWorkspaceAccess<T>(
  pool: Pool,
  { workspaceId, actorId, signal }: WorkspaceActor,
  { mode, capability, statuses }: WorkspaceAccess,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const scope = { workspaceId, actorId };
  const options = signal === undefined ? {} : { signal };
  const roles = rolesForCapability(capability);
  if (mode === 'read')
    return withTenantScopedReadClient(
      pool,
      scope,
      async (client) => {
        await readWorkspaceAuthority(client, workspaceId, {
          actorId,
          roles,
          allowedStatuses: statuses,
        });
        return operation(client);
      },
      options,
    );
  return withTenantScopedClient(
    pool,
    scope,
    async (client) => {
      await lockWorkspaceAuthorityInStatuses(client, workspaceId, {
        actorId,
        roles,
        allowedStatuses: statuses,
      });
      return operation(client);
    },
    options,
  );
}
