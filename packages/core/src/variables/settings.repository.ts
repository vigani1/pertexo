import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  lockWorkspaceAuthority,
  readWorkspaceAuthority,
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '@pertexo/database/primitives';
import {
  BROWSABLE_WORKSPACE_STATUSES,
  rolesForCapability,
  type AuthorizationCapability,
} from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';

import type { VariableScope, WorkspaceVariablesStore } from './contract.js';
import { replaceWorkspaceVariables } from './sets.repository.js';
import { readWorkspaceVariables } from './settings.queries.js';
import { readVariableUsage } from './usage.queries.js';

/** Each action opens its own transaction and decides authority inside it. */
export function createWorkspaceVariablesStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkspaceVariablesStore {
  const lease = acquireDatabasePool(config, runtime);
  /** A suspended workspace stays readable (ADR 013/027); its writes don't. */
  function browse<T>(
    input: VariableScope,
    capability: AuthorizationCapability,
    read: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return withTenantScopedReadClient(
      lease.pool,
      input,
      async (client) => {
        await readWorkspaceAuthority(client, input.workspaceId, {
          actorId: input.actorId,
          roles: rolesForCapability(capability),
          allowedStatuses: BROWSABLE_WORKSPACE_STATUSES,
        });
        return read(client);
      },
      input,
    );
  }
  return {
    close: () => lease.close(),
    read: (input) =>
      browse(input, 'workspace:read', (client) =>
        readWorkspaceVariables(client, input.workspaceId),
      ),
    usage: (input) =>
      browse(input, 'workflow:read', (client) =>
        readVariableUsage(client, input),
      ),
    replace: (input) =>
      withTenantScopedClient(
        lease.pool,
        input,
        async (client) => {
          await lockWorkspaceAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability('variable:manage'),
          );
          return replaceWorkspaceVariables(client, input);
        },
        input,
      ),
  };
}
