import { sql } from 'drizzle-orm';

import {
  workflowActions,
  workflowAccessible,
} from '../../../tenant-access/resources/workflows.queries.js';
import {
  bindResourcePredicate,
  workflowScopeSql,
} from '../../../tenant-access/resources/scope.queries.js';

import { z } from 'zod';

import { mapWorkflow, workflowSetupSelection } from '../representation/rows.js';

import type { ReadStore, WorkflowAuthoringReadContext } from './contract.js';
import { uuidSchema } from './authority.js';

export function readAuthoringWorkflow(
  context: WorkflowAuthoringReadContext,
  workspaceId: Parameters<ReadStore['getWorkflow']>[0],
  workflowId: Parameters<ReadStore['getWorkflow']>[1],
  actorId: Parameters<ReadStore['getWorkflow']>[2],
): ReturnType<ReadStore['getWorkflow']> {
  return context.transact(workspaceId, actorId, async (client) => {
    const access = await context.requireReader(client, workspaceId, actorId);
    if (
      !(await workflowAccessible(client, access, {
        workspaceId,
        workflowId,
      }))
    )
      return null;
    const parameters: unknown[] = [workspaceId, uuidSchema.parse(workflowId)];
    const result = await client.query<
      Record<string, unknown> & { resource_folder_id: string | null }
    >(
      `select *, ${workflowSetupSelection}, (select state.folder_id from app.workflow_organization_state state where state.workspace_id=app.workflows.workspace_id and state.workflow_id=app.workflows.id) resource_folder_id from app.workflows where workspace_id=$1 and id=$2`,
      parameters,
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const { resource_folder_id, ...workflow } = row;
    return {
      ...mapWorkflow(workflow),
      resourceAccess: workflowActions(access, resource_folder_id),
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
    const limit = z
      .number()
      .int()
      .positive()
      .max(100)
      .parse(input.limit ?? 50);
    const order = input.order ?? 'created_asc';
    const afterPositionAt =
      input.after === undefined
        ? null
        : z.iso.datetime({ offset: true }).parse(input.after.positionAt);
    const afterId =
      input.after === undefined ? null : uuidSchema.parse(input.after.id);
    const parameters: unknown[] = [
      input.workspaceId,
      afterPositionAt,
      afterId,
      limit + 1,
      input.pinsWorkflowId === undefined
        ? null
        : uuidSchema.parse(input.pinsWorkflowId),
    ];
    const visible = bindResourcePredicate(
      workflowScopeSql(access, sql`app.workflows.id`),
      parameters,
    );
    const result = await client.query<
      Record<string, unknown> & { resource_folder_id: string | null }
    >(
      order === 'updated_desc'
        ? `select *, ${workflowSetupSelection}, (select state.folder_id from app.workflow_organization_state state where state.workspace_id=app.workflows.workspace_id and state.workflow_id=app.workflows.id) resource_folder_id, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_position_at
               from app.workflows where workspace_id = $1 and ${visible}
                 and ($5::uuid is null or exists(select 1 from app.workflow_version_dependencies dependency
                   where dependency.workspace_id=$1 and dependency.parent_version_id=app.workflows.published_version_id
                     and dependency.target_workflow_id=$5))
                 and ($2::timestamptz is null or (updated_at, id) < ($2::timestamptz, $3::uuid))
               order by updated_at desc, id desc limit $4`
        : `select *, ${workflowSetupSelection}, (select state.folder_id from app.workflow_organization_state state where state.workspace_id=app.workflows.workspace_id and state.workflow_id=app.workflows.id) resource_folder_id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_position_at
               from app.workflows where workspace_id = $1 and ${visible}
                 and ($5::uuid is null or exists(select 1 from app.workflow_version_dependencies dependency
                   where dependency.workspace_id=$1 and dependency.parent_version_id=app.workflows.published_version_id
                     and dependency.target_workflow_id=$5))
                 and ($2::timestamptz is null or (created_at, id) > ($2::timestamptz, $3::uuid))
               order by created_at, id limit $4`,
      parameters,
    );
    const hasMore = result.rows.length > limit;
    const pageRows = result.rows.slice(0, limit);
    const items = Object.freeze(
      pageRows.map((row) => {
        const workflowRow: Record<string, unknown> = { ...row };
        delete workflowRow.cursor_position_at;
        delete workflowRow.resource_folder_id;
        return {
          ...mapWorkflow(workflowRow),
          resourceAccess: workflowActions(access, row.resource_folder_id),
        };
      }),
    );
    const last = items.at(-1);
    return Object.freeze({
      items,
      ...(hasMore && last !== undefined
        ? {
            nextCursor: Object.freeze({
              positionAt: z.string().parse(pageRows.at(-1)?.cursor_position_at),
              id: last.id,
            }),
          }
        : {}),
    });
  });
}
