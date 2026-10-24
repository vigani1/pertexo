import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, desc, lt } from 'drizzle-orm';
import {
  workflows,
  workflowVersions,
} from '../../../schema/authoring/workflows.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { z } from 'zod';
import { WorkflowNotFoundError } from '../errors.js';

import {
  projectVersion,
  versionProjection,
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
    const [row] = await drizzle(client)
      .select(versionProjection)
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.workspaceId, workspaceId),
          eq(workflowVersions.workflowId, uuidSchema.parse(workflowId)),
          eq(workflowVersions.id, uuidSchema.parse(versionId)),
        ),
      )
      .catch(rethrowQueryFailure);
    return row === undefined ? null : projectVersion(row);
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
    const visible = await drizzle(client)
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.workspaceId, input.workspaceId),
          eq(workflows.id, workflowId),
        ),
      )
      .catch(rethrowQueryFailure);
    if (visible.length !== 1)
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
    const result = await drizzle(client)
      .select(versionProjection)
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.workspaceId, input.workspaceId),
          eq(workflowVersions.workflowId, workflowId),
          beforeVersionNumber === null
            ? undefined
            : lt(workflowVersions.versionNumber, beforeVersionNumber),
          input.versionId === undefined
            ? undefined
            : eq(workflowVersions.id, input.versionId),
        ),
      )
      .orderBy(desc(workflowVersions.versionNumber))
      .limit(limit + 1)
      .catch(rethrowQueryFailure);
    const hasMore = result.length > limit;
    const items = Object.freeze(result.slice(0, limit).map(projectVersion));
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
