import { and, asc, desc, eq, exists, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowVersionDependencies,
  workflowOrganizationState,
  workflows,
} from '@pertexo/database/schema';
import type { FolderScope } from '../../../shared/contract.js';
import { workflowScopeSql } from '../../../shared/scope.queries.js';
import {
  workflowAccessible,
  workflowActions,
} from '../../../tenant-access/resources/workflows.queries.js';
import { workflowProjection } from '../representation/records.queries.js';
import type { ReadStore, WorkflowAuthoringReadContext } from './contract.js';

const folder = new QueryBuilder()
  .select({ id: workflowOrganizationState.folderId })
  .from(workflowOrganizationState)
  .where(
    and(
      eq(workflowOrganizationState.workspaceId, workflows.workspaceId),
      eq(workflowOrganizationState.workflowId, workflows.id),
    ),
  );
const readProjection = {
  workflow: workflowProjection,
  resource_folder_id: sql<string | null>`(${folder})`,
};
export function readAuthoringWorkflow(
  context: WorkflowAuthoringReadContext,
  workspaceId: Parameters<ReadStore['getWorkflow']>[0],
  workflowId: Parameters<ReadStore['getWorkflow']>[1],
  actorId: Parameters<ReadStore['getWorkflow']>[2],
): ReturnType<ReadStore['getWorkflow']> {
  return context.transact(workspaceId, actorId, async (client) => {
    const access = await context.requireReader(client, workspaceId, actorId);
    if (
      !(await workflowAccessible(client, access, { workspaceId, workflowId }))
    )
      return null;
    const [row] = await drizzle(client)
      .select(readProjection)
      .from(workflows)
      .where(
        and(
          eq(workflows.workspaceId, workspaceId),
          eq(workflows.id, workflowId),
        ),
      )
      .catch(rethrowQueryFailure);
    if (row === undefined) return null;
    return {
      ...row.workflow,
      resourceAccess: workflowActions(access, row.resource_folder_id),
    };
  });
}
export function listAuthoringWorkflows(
  context: WorkflowAuthoringReadContext,
  input: Parameters<ReadStore['listWorkflows']>[0],
): ReturnType<ReadStore['listWorkflows']> {
  return context.transact(input.workspaceId, input.actorId, async (client) => {
    const access = await context.requireReader(
      client,
      input.workspaceId,
      input.actorId,
    );
    const parsed = listInput(input),
      rows = await listRows(client, parsed, access);
    const hasMore = rows.length > parsed.limit,
      pageRows = rows.slice(0, parsed.limit);
    const items = Object.freeze(
      pageRows.map((row) => ({
        ...row.workflow,
        resourceAccess: workflowActions(access, row.resource_folder_id),
      })),
    );
    const lastRow = pageRows.at(-1);
    return Object.freeze({
      items,
      ...(hasMore && lastRow !== undefined
        ? {
            nextCursor: Object.freeze({
              positionAt: lastRow.cursor_position_at,
              id: lastRow.workflow.id,
            }),
          }
        : {}),
    });
  });
}
function listInput(input: Parameters<ReadStore['listWorkflows']>[0]) {
  return {
    workspaceId: input.workspaceId,
    limit: input.limit ?? 50,
    order: input.order ?? 'created_asc',
    afterPositionAt: input.after?.positionAt ?? null,
    afterId: input.after?.id ?? null,
    pinsWorkflowId: input.pinsWorkflowId ?? null,
  };
}
function listRows(
  client: PoolClient,
  input: ReturnType<typeof listInput>,
  access: FolderScope,
) {
  const db = drizzle(client),
    w = workflows,
    d = workflowVersionDependencies;
  const position = input.order === 'updated_desc' ? w.updatedAt : w.createdAt;
  const pinned = db
    .select({ id: d.targetWorkflowId })
    .from(d)
    .where(
      and(
        eq(d.workspaceId, input.workspaceId),
        eq(d.parentVersionId, w.publishedVersionId),
        eq(d.targetWorkflowId, sql`${input.pinsWorkflowId}::uuid`),
      ),
    );
  const after =
    input.order === 'updated_desc'
      ? sql`(${position},${w.id})<(${input.afterPositionAt}::timestamptz,${input.afterId}::uuid)`
      : sql`(${position},${w.id})>(${input.afterPositionAt}::timestamptz,${input.afterId}::uuid)`;
  return db
    .select({
      ...readProjection,
      cursor_position_at: sql<string>`to_char(${position} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(w)
    .where(
      and(
        eq(w.workspaceId, input.workspaceId),
        workflowScopeSql(access, sql`${w.id}`),
        input.pinsWorkflowId === null ? undefined : exists(pinned),
        input.afterPositionAt === null ? undefined : after,
      ),
    )
    .orderBy(
      ...(input.order === 'updated_desc'
        ? [desc(position), desc(w.id)]
        : [asc(position), asc(w.id)]),
    )
    .limit(input.limit + 1)
    .catch(rethrowQueryFailure);
}
