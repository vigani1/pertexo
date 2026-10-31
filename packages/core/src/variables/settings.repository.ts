import { drizzle } from 'drizzle-orm/node-postgres';
import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  lockWorkspaceAuthority,
  parseWorkspaceId,
  readWorkspaceAuthority,
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '@pertexo/database/primitives';
import { databaseSchema } from '@pertexo/database/schema';
import { rolesForCapability } from '@pertexo/workflow-model';
import { readWorkspaceVariables } from './settings.queries.js';
import { replaceWorkspaceVariables } from './sets.repository.js';
import { readVariableUsage } from './usage.queries.js';
import type { WorkspaceVariablesStore } from './contract.js';
export function createWorkspaceVariablesStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkspaceVariablesStore {
  const lease = acquireDatabasePool(config, runtime);
  return {
    close: () => lease.close(),
    read: (input) =>
      withTenantScopedReadClient(
        lease.pool,
        { workspaceId: input.workspaceId, actorId: input.actorId },
        async (client) => {
          await readWorkspaceAuthority(client, input.workspaceId, {
            actorId: input.actorId,
            roles: rolesForCapability('workspace:read'),
            allowedStatuses: ['active', 'suspended', 'pending_deletion'],
          });
          return readWorkspaceVariables({
            db: drizzle(client, { schema: databaseSchema }),
            workspaceId: parseWorkspaceId(input.workspaceId),
          });
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
    replace: (input) =>
      withTenantScopedClient(
        lease.pool,
        { workspaceId: input.workspaceId, actorId: input.actorId },
        async (client) => {
          await lockWorkspaceAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability('variable:manage'),
          );
          return replaceWorkspaceVariables(client, input);
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
    usage: (input) =>
      withTenantScopedReadClient(
        lease.pool,
        { workspaceId: input.workspaceId, actorId: input.actorId },
        async (client) => {
          await readWorkspaceAuthority(client, input.workspaceId, {
            actorId: input.actorId,
            roles: rolesForCapability('workflow:read'),
            allowedStatuses: ['active', 'suspended', 'pending_deletion'],
          });
          return readVariableUsage(client, input);
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
  };
}
