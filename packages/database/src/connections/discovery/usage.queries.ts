import {
  connectionScope,
  connectionScopeSql,
} from '../../tenant-access/resources/connections/scope.js';
import { sql } from 'drizzle-orm';
import { readFolderScope } from '../../tenant-access/resources/facts.js';
import {
  bindResourcePredicate,
  workflowScopeSql,
} from '../../tenant-access/resources/query-scope.js';
import { lockWorkspaceAuthority } from '../../tenant-access/workspaces/authority.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import type { Pool } from 'pg';
import { z } from 'zod';

import { rolesForCapability } from '@pertexo/workflow-model';
import {
  ConnectionNotFoundError,
  uuidSchema,
  withConnectionTransaction,
} from '../records.queries.js';

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
function connectionUsagePageSql(visible: string): string {
  return `with page as materialized (
  select usage.workflow_version_id, array_agg(distinct usage.operation_key order by usage.operation_key) as operation_keys
  from app.workflow_integration_usage usage
  join app.workflow_versions version on version.workspace_id=usage.workspace_id and version.id=usage.workflow_version_id
  where usage.workspace_id = $1 and usage.connection_id = $2 and (${visible})
    and ($3::uuid is null or usage.workflow_version_id > $3::uuid)
  group by usage.workflow_version_id
  order by usage.workflow_version_id
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
}
export const CONNECTION_USAGE_PAGE_SQL = connectionUsagePageSql('true');

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
      return withConnectionTransaction(pool, input.workspaceId, {
        actorId,
        operation: async (client, workspaceId) => {
          let role;
          try {
            role = await lockWorkspaceAuthority(
              client,
              workspaceId,
              actorId,
              rolesForCapability('connection:read'),
            );
          } catch (error) {
            if (error instanceof WorkspaceAccessDeniedError)
              throw new ConnectionNotFoundError('Connection is not visible');
            throw error;
          }
          const resources = await readFolderScope(
            client,
            { workspaceId, actorId },
            role,
          );
          const connectionParameters: unknown[] = [workspaceId, connectionId];
          const permitted = bindResourcePredicate(
            connectionScopeSql(
              connectionScope(
                { workspaceId, actorId },
                role,
                'connection:read',
              ),
            ),
            connectionParameters,
          );
          const connection = await client.query(
            `select id from app.connections connection where workspace_id=$1 and id=$2 and ${permitted}`,
            connectionParameters,
          );
          if (connection.rowCount !== 1)
            throw new ConnectionNotFoundError('Connection is not visible');
          if (after !== undefined) {
            const parameters: unknown[] = [workspaceId, connectionId, after];
            const visible = bindResourcePredicate(
              workflowScopeSql(resources, sql`version.workflow_id`),
              parameters,
            );
            const anchor = await client.query(
              `select 1 from app.workflow_integration_usage usage
              join app.workflow_versions version on version.workspace_id=usage.workspace_id and version.id=usage.workflow_version_id
              where usage.workspace_id=$1 and usage.connection_id=$2 and usage.workflow_version_id=$3 and ${visible} limit 1`,
              parameters,
            );
            if (anchor.rowCount !== 1)
              throw new ConnectionNotFoundError(
                'Connection usage cursor is not visible',
              );
          }
          const parameters: unknown[] = [
            workspaceId,
            connectionId,
            after ?? null,
            limit + 1,
          ];
          const visible = bindResourcePredicate(
            workflowScopeSql(resources, sql`version.workflow_id`),
            parameters,
          );
          const result = await client.query(
            connectionUsagePageSql(visible),
            parameters,
          );
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
      });
    },
  });
}
