import type { Pool } from 'pg';
import { z } from 'zod';

import { rolesForCapability } from '../tenant-access/workspace-policy.js';
import {
  ConnectionNotFoundError,
  uuidSchema,
  withConnectionTransaction,
} from './connection-persistence.js';

export type ConnectionUsageRecord = Readonly<{
  workflowId: string;
  workflowName: string;
  workflowLifecycleStatus: 'active' | 'archived';
  workflowVersionId: string;
  versionNumber: number;
  isCurrentPublication: boolean;
  operationKeys: readonly string[];
}>;
export type ConnectionUsageCursor = Readonly<{ workflowVersionId: string }>;
export type ConnectionUsagePage = Readonly<{
  items: readonly ConnectionUsageRecord[];
  nextCursor?: ConnectionUsageCursor;
}>;
export type ListConnectionUsageInput = Readonly<{
  workspaceId: string;
  actorId: string;
  connectionId: string;
  limit?: number;
  after?: ConnectionUsageCursor;
}>;
export type ConnectionUsageDatabase = Readonly<{
  listConnectionUsage(
    input: ListConnectionUsageInput,
  ): Promise<ConnectionUsagePage>;
}>;

/** The projection index pages version identities before bounded metadata joins. */
export const CONNECTION_USAGE_PAGE_SQL = `with page as materialized (
  select workflow_version_id, array_agg(distinct operation_key order by operation_key) as operation_keys
  from app.workflow_integration_usage
  where workspace_id = $1 and connection_id = $2
    and ($3::uuid is null or workflow_version_id > $3::uuid)
  group by workflow_version_id
  order by workflow_version_id
  limit $4
)
select workflow.id as workflow_id, workflow.name as workflow_name,
  workflow.lifecycle_status, version.id as workflow_version_id,
  version.version_number,
  (workflow.published_version_id = version.id) as is_current_publication,
  page.operation_keys
from page
join app.workflow_versions version on version.workspace_id = $1 and version.id = page.workflow_version_id
join app.workflows workflow on workflow.workspace_id = $1 and workflow.id = version.workflow_id
order by page.workflow_version_id`;

const rowSchema = z.object({
  workflow_id: z.uuid(),
  workflow_name: z.string().min(1).max(128),
  lifecycle_status: z.enum(['active', 'archived']),
  workflow_version_id: z.uuid(),
  version_number: z.number().int().positive(),
  is_current_publication: z.boolean().nullable(),
  operation_keys: z.array(z.string().min(1).max(128)),
});

export function createConnectionUsagePersistence(
  pool: Pool,
): ConnectionUsageDatabase {
  return Object.freeze({
    listConnectionUsage: (input) => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      const limit = z
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(input.limit ?? 50);
      const after =
        input.after === undefined
          ? undefined
          : uuidSchema.parse(input.after.workflowVersionId);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          const authority = await client.query(
            `select 1
          from app.workspace_memberships membership
          join app.workspaces workspace on workspace.id = membership.workspace_id
          join app.users actor on actor.id = membership.user_id
          where membership.workspace_id = $1 and membership.user_id = $2
            and membership.status = 'active' and workspace.status = 'active' and actor.status = 'active'
            and membership.role = any($3::text[]) and membership.role = any($4::text[])
          for share of membership, workspace, actor`,
            [
              workspaceId,
              actorId,
              [...rolesForCapability('connection:read')],
              [...rolesForCapability('workflow:read')],
            ],
          );
          if (authority.rowCount !== 1)
            throw new ConnectionNotFoundError('Connection is not visible');
          const connection = await client.query(
            'select id from app.connections where workspace_id = $1 and id = $2',
            [workspaceId, connectionId],
          );
          if (connection.rowCount !== 1)
            throw new ConnectionNotFoundError('Connection is not visible');
          if (after !== undefined) {
            const anchor = await client.query(
              `select 1 from app.workflow_integration_usage
            where workspace_id = $1 and connection_id = $2 and workflow_version_id = $3 limit 1`,
              [workspaceId, connectionId, after],
            );
            if (anchor.rowCount !== 1)
              throw new ConnectionNotFoundError(
                'Connection usage cursor is not visible',
              );
          }
          const result = await client.query(CONNECTION_USAGE_PAGE_SQL, [
            workspaceId,
            connectionId,
            after ?? null,
            limit + 1,
          ]);
          const items = Object.freeze(
            result.rows.slice(0, limit).map((value): ConnectionUsageRecord => {
              const row = rowSchema.parse(value);
              return Object.freeze({
                workflowId: row.workflow_id,
                workflowName: row.workflow_name,
                workflowLifecycleStatus: row.lifecycle_status,
                workflowVersionId: row.workflow_version_id,
                versionNumber: row.version_number,
                isCurrentPublication: row.is_current_publication ?? false,
                operationKeys: Object.freeze(row.operation_keys),
              });
            }),
          );
          const last = items.at(-1);
          return Object.freeze({
            items,
            ...(result.rows.length > limit && last !== undefined
              ? {
                  nextCursor: Object.freeze({
                    workflowVersionId: last.workflowVersionId,
                  }),
                }
              : {}),
          });
        },
      );
    },
  });
}
