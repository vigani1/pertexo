import {
  lockWorkspaceAuthorityInStatuses,
  lockWorkspaceRow,
  readWorkspaceAuthority,
  readWorkspaceRole,
} from './authority.queries.js';
import { drizzle } from 'drizzle-orm/node-postgres';
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
  signal?: AbortSignal | undefined;
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
  /** For a request-path flow that must give up rather than hold a connection. */
  statementTimeoutMillis?: number | undefined;
}>;

/**
 * A snapshot read that refuses no one: its rows are filtered by the role, so
 * someone without access, or a workspace outside the list, gets an empty answer
 * rather than a denial, and can't tell a workspace exists. The operation gets
 * null for the role, and it decides nothing from a capability.
 */
export type WorkspaceVisibility = Readonly<{
  mode: 'visible';
  statuses: WorkspaceStatusList;
  statementTimeoutMillis?: number | undefined;
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
  actor: WorkspaceActor,
  access: WorkspaceVisibility,
  operation: (client: PoolClient, role: Role | null) => Promise<T>,
): Promise<T>;
export function withWorkspaceAccess<T>(
  pool: Pool,
  actor: WorkspaceActor,
  access: WorkspaceAccess,
  operation: (client: PoolClient, role: Role) => Promise<T>,
): Promise<T>;
export function withWorkspaceAccess<T>(
  pool: Pool,
  { workspaceId, actorId, signal }: WorkspaceActor,
  access: WorkspaceAccess | WorkspaceVisibility,
  operation: (client: PoolClient, role: never) => Promise<T>,
): Promise<T> {
  const scope = { workspaceId, actorId };
  const { statuses, statementTimeoutMillis } = access;
  const options = {
    ...(signal === undefined ? {} : { signal }),
    ...(statementTimeoutMillis === undefined ? {} : { statementTimeoutMillis }),
  };
  // The overloads pair each mode with the role it gives the operation.
  const run = operation as (
    client: PoolClient,
    role: Role | null,
  ) => Promise<T>;
  if (access.mode === 'visible')
    return withTenantScopedReadClient(
      pool,
      scope,
      async (client) =>
        run(client, await readWorkspaceRole(drizzle(client), scope, statuses)),
      options,
    );
  const roles = rolesForCapability(access.capability);
  if (access.mode === 'read')
    return withTenantScopedReadClient(
      pool,
      scope,
      async (client) => {
        const role = await readWorkspaceAuthority(client, workspaceId, {
          actorId,
          roles,
          allowedStatuses: statuses,
        });
        return run(client, role);
      },
      options,
    );
  return withTenantScopedClient(
    pool,
    scope,
    async (client) => {
      if (access.mode === 'exclusive')
        await lockWorkspaceRow(client, workspaceId);
      const role = await lockWorkspaceAuthorityInStatuses(client, workspaceId, {
        actorId,
        roles,
        allowedStatuses: statuses,
      });
      return run(client, role);
    },
    options,
  );
}
