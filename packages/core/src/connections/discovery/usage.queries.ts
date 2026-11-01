import { and, eq, gt, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowIntegrationUsage as usage,
  workflowVersions as version,
  workflows as workflow,
} from '@pertexo/database/schema';
import type { Role } from '@pertexo/workflow-model';
import type { FolderScope } from '../../tenant-access/resources/contract.js';
import { readFolderScope } from '../../shared/facts.queries.js';
import { workflowScopeSql } from '../../shared/scope.queries.js';
import { ConnectionNotFoundError } from '../contract.js';
import { requireVisibleConnection } from '../records.queries.js';
import type {
  ConnectionUsagePage,
  ConnectionUsageRecord,
  ListConnectionUsageInput,
} from './contract.js';
import { DEFAULT_CONNECTION_PAGE_SIZE } from './reads.queries.js';

/** The projection index pages version identities before bounded metadata joins. */
export function connectionUsagePage(
  db: Pick<NodePgDatabase, 'select' | '$with' | 'with'>,
  input: Readonly<{
    workspaceId: string;
    connectionId: string;
    after?: string | undefined;
    limit: number;
    resources: FolderScope;
  }>,
) {
  const page = db.$with('page').as(
    db
      .select({
        workflowVersionId: usage.workflowVersionId,
        operationKeys: sql<
          string[]
        >`array_agg(distinct ${usage.operationKey} order by ${usage.operationKey})`.as(
          'operation_keys',
        ),
      })
      .from(usage)
      .innerJoin(
        version,
        and(
          eq(version.workspaceId, usage.workspaceId),
          eq(version.id, usage.workflowVersionId),
        ),
      )
      .where(
        and(
          eq(usage.workspaceId, input.workspaceId),
          eq(usage.connectionId, input.connectionId),
          workflowScopeSql(input.resources, sql`${version.workflowId}`),
          input.after === undefined
            ? undefined
            : gt(usage.workflowVersionId, input.after),
        ),
      )
      .groupBy(usage.workflowVersionId)
      .orderBy(usage.workflowVersionId)
      .limit(input.limit),
  );
  return db
    .with(page)
    .select({
      workflowId: workflow.id,
      workflowName: workflow.name,
      workflowLifecycleStatus: sql<
        ConnectionUsageRecord['workflowLifecycleStatus']
      >`${workflow.lifecycleStatus}`,
      workflowVersionId: version.id,
      versionNumber: version.versionNumber,
      isCurrentPublication: sql<boolean>`coalesce(${workflow.publishedVersionId}=${version.id},false)`,
      operationKeys: page.operationKeys,
    })
    .from(page)
    .innerJoin(
      version,
      and(
        eq(version.workspaceId, input.workspaceId),
        eq(version.id, page.workflowVersionId),
      ),
    )
    .innerJoin(
      workflow,
      and(
        eq(workflow.workspaceId, input.workspaceId),
        eq(workflow.id, version.workflowId),
      ),
    )
    .orderBy(page.workflowVersionId);
}

export async function listConnectionUsage(
  client: PoolClient,
  input: ListConnectionUsageInput,
  role: Role,
): Promise<ConnectionUsagePage> {
  const { workspaceId, connectionId } = input;
  const limit = input.limit ?? DEFAULT_CONNECTION_PAGE_SIZE;
  const after = input.after?.workflowVersionId;
  const resources = await readFolderScope(client, input, role);
  await requireVisibleConnection(client, input, role, 'connection:read');
  const db = drizzle(client);
  if (after !== undefined) {
    const anchor = await db
      .select({ id: usage.workflowVersionId })
      .from(usage)
      .innerJoin(
        version,
        and(
          eq(version.workspaceId, usage.workspaceId),
          eq(version.id, usage.workflowVersionId),
        ),
      )
      .where(
        and(
          eq(usage.workspaceId, workspaceId),
          eq(usage.connectionId, connectionId),
          eq(usage.workflowVersionId, after),
          workflowScopeSql(resources, sql`${version.workflowId}`),
        ),
      )
      .limit(1)
      .catch(rethrowQueryFailure);
    if (anchor.length !== 1)
      throw new ConnectionNotFoundError(
        'Connection usage cursor is not visible',
      );
  }
  const result = await connectionUsagePage(db, {
    workspaceId,
    connectionId,
    after,
    limit: limit + 1,
    resources,
  });
  const items = Object.freeze(
    result.slice(0, limit).map((row) =>
      Object.freeze({
        ...row,
        operationKeys: Object.freeze(row.operationKeys),
      }),
    ),
  );
  const last = items.at(-1);
  return Object.freeze({
    items,
    ...(result.length > limit && last !== undefined
      ? {
          nextCursor: Object.freeze({
            workflowVersionId: last.workflowVersionId,
          }),
        }
      : {}),
  });
}
