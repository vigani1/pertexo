import { z } from 'zod';
import { WorkflowNotFoundError } from '../errors.js';

import {
  mapVersion,
  workflowVersionRowSelection,
} from '../representation/records.queries.js';

import type { ReadStore, WorkflowAuthoringReadContext } from './contract.js';
import { uuidSchema, canReadWorkflow } from './authority.js';

export function readAuthoringVersion(
  context: WorkflowAuthoringReadContext,
  workspaceId: Parameters<ReadStore['getVersion']>[0],
  {
    workflowId,
    versionId,
    actorId,
  }: Readonly<{
    workflowId: Parameters<ReadStore['getVersion']>[1];
    versionId: Parameters<ReadStore['getVersion']>[2];
    actorId: Parameters<ReadStore['getVersion']>[3];
  }>,
): ReturnType<ReadStore['getVersion']> {
  return context.transact(workspaceId, actorId, async (client) => {
    if (
      !(await canReadWorkflow(context, client, {
        workspaceId,
        actorId,
        workflowId,
      }))
    )
      return null;
    const result = await client.query<Record<string, unknown>>(
      `select ${workflowVersionRowSelection} from app.workflow_versions
           where workspace_id = $1 and workflow_id = $2 and id = $3`,
      [workspaceId, uuidSchema.parse(workflowId), uuidSchema.parse(versionId)],
    );
    return result.rows[0] === undefined ? null : mapVersion(result.rows[0]);
  });
}

export function listAuthoringVersions(
  context: WorkflowAuthoringReadContext,
  input: Parameters<ReadStore['listVersions']>[0],
): ReturnType<ReadStore['listVersions']> {
  return context.transact(input.workspaceId, input.actorId, async (client) => {
    if (
      !(await canReadWorkflow(context, client, {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        workflowId: input.workflowId,
      }))
    )
      throw new WorkflowNotFoundError('Workflow is not visible');
    const workflowId = uuidSchema.parse(input.workflowId);
    const visible = await client.query(
      'select 1 from app.workflows where workspace_id = $1 and id = $2',
      [input.workspaceId, workflowId],
    );
    if (visible.rowCount !== 1)
      throw new WorkflowNotFoundError('Workflow is not visible');
    const limit = z
      .number()
      .int()
      .positive()
      .max(100)
      .parse(input.limit ?? 50);
    const beforeVersionNumber =
      input.beforeVersionNumber === undefined
        ? null
        : z.number().int().positive().parse(input.beforeVersionNumber);
    const result = await client.query<Record<string, unknown>>(
      `select ${workflowVersionRowSelection} from app.workflow_versions
           where workspace_id = $1 and workflow_id = $2
             and ($3::integer is null or version_number < $3)
             and ($5::uuid is null or id = $5)
           order by version_number desc limit $4`,
      [
        input.workspaceId,
        workflowId,
        beforeVersionNumber,
        limit + 1,
        input.versionId ?? null,
      ],
    );
    const hasMore = result.rows.length > limit;
    const items = Object.freeze(
      result.rows.slice(0, limit).map((row) => mapVersion(row)),
    );
    const last = items.at(-1);
    return Object.freeze({
      items,
      ...(hasMore && last !== undefined
        ? {
            nextCursor: Object.freeze({
              beforeVersionNumber: last.versionNumber,
            }),
          }
        : {}),
    });
  });
}
