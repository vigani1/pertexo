import { and, eq, gt, sql } from 'drizzle-orm';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { PoolClient } from 'pg';

import { rethrowQueryFailure } from '@pertexo/database/primitives';

import {
  workflowIntegrationUsage as usage,
  workflowVersions as version,
  workflows as workflow,
} from '@pertexo/database/schema';

import type { FolderScope } from '../../shared/folder-access.types.js';

import type { readFolderScope } from '../../shared/folder-access-facts.repository.js';

import { workflowScopeSql } from '../../shared/folder-scope.repository.js';

import type {
  ConnectionUsageRecord,
  ListConnectionUsageInput,
} from './connection-usage.types.js';

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

/** Whether the cursor's version still uses the connection within the actor's scope. */
export async function usageCursorVisible(
  client: PoolClient,
  input: ListConnectionUsageInput,
  resources: Awaited<ReturnType<typeof readFolderScope>>,
  after: string,
): Promise<boolean> {
  const { workspaceId, connectionId } = input;
  const db = drizzle(client);
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
  return anchor.length === 1;
}
