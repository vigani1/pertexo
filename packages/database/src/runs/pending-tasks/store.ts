import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '../../tenant-access/transactions.js';
import {
  lockWorkspaceAuthority,
  readWorkspaceAuthority,
} from '../../tenant-access/workspaces/authority.js';
import { rolesForCapability } from '../../tenant-access/policy.js';
import { decideTask } from './decide.js';
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
          const role = await readWorkspaceAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability('run:read'),
          );
          return listTasks(client, input, role);
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
    read: (input) =>
      withTenantScopedReadClient(
        lease.pool,
        { workspaceId: input.workspaceId, actorId: input.actorId },
        async (client) => {
          const role = await readWorkspaceAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability('run:read'),
          );
          return projectTask(await readTaskRow(client, input, role));
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
          return decideTask(client, input, role);
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
    audience: (input) =>
      withTenantScopedReadClient(
        lease.pool,
        { workspaceId: input.workspaceId, actorId: input.actorId },
        async (client) => {
          await readWorkspaceAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability('workflow:update'),
          );
          const rows = await client.query<{
            userId: string;
            displayName: string;
            role: 'owner' | 'admin' | 'builder' | 'operator' | 'viewer';
          }>(
            `select member.user_id "userId",actor.display_name "displayName",member.role from app.workspace_memberships member join app.users actor on actor.id=member.user_id and actor.status='active'
        where member.workspace_id=$1 and member.status='active' and ($2::uuid is null or member.user_id>$2) and position(lower($3) in lower(actor.display_name))>0 order by member.user_id limit 51`,
            [input.workspaceId, input.after ?? null, input.q],
          );
          const page = rows.rows.slice(0, 50);
          return {
            items: page,
            nextCursor:
              rows.rows.length > 50 ? (page.at(-1)?.userId ?? null) : null,
          };
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
  } satisfies PendingTaskStore);
}
