import { readFolderScope } from '../../../tenant-access/resources/facts.queries.js';
import { readWorkspacePeople } from '../../../tenant-access/members/discovery.queries.js';
import type { DatabaseConfig } from '../../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../../platform/pool/runtime.js';
import {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '../../../tenant-access/transactions.js';
import {
  lockWorkspaceAuthority,
  readWorkspaceAuthority,
} from '../../../tenant-access/workspaces/authority.queries.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import { respondToTask } from './respond.js';
import { inspectAudience } from './inspect-audience.js';
import { listTasks, projectTask, readTaskRow } from './queries.js';
import type { PendingTaskStore } from './contract.js';

export {
  PendingTaskDecisionError,
  PendingTaskNotFoundError,
  type PendingTaskStore,
} from './contract.js';
export function createPendingTaskStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): PendingTaskStore {
  const lease = acquireDatabasePool(config, runtime);
  return Object.freeze({
    close: () => lease.close(),
    list: (input) =>
      withTenantScopedReadClient(
        lease.pool,
        { workspaceId: input.workspaceId, actorId: input.actorId },
        async (client) => {
          const role = await readWorkspaceAuthority(client, input.workspaceId, {
            actorId: input.actorId,
            roles: rolesForCapability('run:read'),
          });
          return listTasks(
            client,
            input,
            role,
            await readFolderScope(client, input, role),
          );
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
    read: (input) =>
      withTenantScopedReadClient(
        lease.pool,
        { workspaceId: input.workspaceId, actorId: input.actorId },
        async (client) => {
          const role = await readWorkspaceAuthority(client, input.workspaceId, {
            actorId: input.actorId,
            roles: rolesForCapability('run:read'),
          });
          return projectTask(
            await readTaskRow(client, input, {
              role,
              resources: await readFolderScope(client, input, role),
            }),
          );
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
    decide: (input) =>
      withTenantScopedClient(
        lease.pool,
        { workspaceId: input.workspaceId, actorId: input.actorId },
        async (client) => {
          const role = await lockWorkspaceAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability('run:read'),
          );
          return respondToTask(
            client,
            { ...input, kind: 'approval' },
            role,
            await readFolderScope(client, input, role),
          );
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
    submit: (input) =>
      withTenantScopedClient(
        lease.pool,
        { workspaceId: input.workspaceId, actorId: input.actorId },
        async (client) => {
          const role = await lockWorkspaceAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability('run:read'),
          );
          return respondToTask(
            client,
            { ...input, kind: 'input_request' },
            role,
            await readFolderScope(client, input, role),
          );
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
    inspectAudience: (input) =>
      withTenantScopedReadClient(
        lease.pool,
        { workspaceId: input.workspaceId, actorId: input.actorId },
        async (client) => {
          await readWorkspaceAuthority(client, input.workspaceId, {
            actorId: input.actorId,
            roles: rolesForCapability('workflow:update'),
          });
          return inspectAudience(client, input);
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
    audience: (input) =>
      withTenantScopedReadClient(
        lease.pool,
        { workspaceId: input.workspaceId, actorId: input.actorId },
        async (client) => {
          await readWorkspaceAuthority(client, input.workspaceId, {
            actorId: input.actorId,
            roles: rolesForCapability('workflow:update'),
          });
          return readWorkspacePeople(client, input);
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
  } satisfies PendingTaskStore);
}
