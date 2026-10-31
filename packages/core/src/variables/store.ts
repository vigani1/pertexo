import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  ACTIVE_WORKSPACE_STATUSES,
  UNPURGED_WORKSPACE_STATUSES,
} from '@pertexo/workflow-model';

import { withWorkspaceAccess, type WorkspaceActor } from '../shared/index.js';
import type {
  ReplaceWorkspaceVariablesInput,
  VariableUsageInput,
} from './contract.js';
import { replaceWorkspaceVariables } from './replace.js';
import { readWorkspaceVariables } from './set.queries.js';
import { readVariableUsage } from './usage.queries.js';

export type WorkspaceVariablesStore = ReturnType<
  typeof createWorkspaceVariablesStore
>;

/** Each action opens its own transaction and decides authority inside it. */
export function createWorkspaceVariablesStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  return {
    close: () => lease.close(),
    read: (actor: WorkspaceActor) =>
      withWorkspaceAccess(
        lease.pool,
        actor,
        {
          mode: 'read',
          capability: 'workspace:read',
          statuses: UNPURGED_WORKSPACE_STATUSES,
        },
        (client) => readWorkspaceVariables(client, actor.workspaceId),
      ),
    usage: (input: VariableUsageInput) =>
      withWorkspaceAccess(
        lease.pool,
        input,
        {
          mode: 'read',
          capability: 'workflow:read',
          statuses: UNPURGED_WORKSPACE_STATUSES,
        },
        (client, role) => readVariableUsage(client, input, role),
      ),
    replace: (input: ReplaceWorkspaceVariablesInput) =>
      withWorkspaceAccess(
        lease.pool,
        input,
        {
          mode: 'change',
          capability: 'variable:manage',
          statuses: ACTIVE_WORKSPACE_STATUSES,
        },
        (client) => replaceWorkspaceVariables(client, input),
      ),
  };
}
