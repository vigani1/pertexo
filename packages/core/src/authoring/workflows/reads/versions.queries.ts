import { and, desc, eq, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workflows, workflowVersions } from '@pertexo/database/schema';
import { WorkflowNotFoundError } from '../errors.js';

import {
  projectVersion,
  versionProjection,
} from '../representation/records.queries.js';

import type { PoolClient } from 'pg';
import type { FolderScope } from '../../../shared/contract.js';
import { workflowAccessible } from '../../../tenant-access/resources/workflows.queries.js';
import type { WorkflowRef } from '../access.js';
import type { ListWorkflowVersionsInput } from '../contract.js';

export async function readVersion(
  client: PoolClient,
  scope: FolderScope,
  workflow: WorkflowRef,
  versionId: string,
) {
  const { workspaceId, workflowId } = workflow;
  if (!(await workflowAccessible(client, scope, workflow))) return null;
  const [row] = await drizzle(client)
    .select(versionProjection)
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, workspaceId),
        eq(workflowVersions.workflowId, workflowId),
        eq(workflowVersions.id, versionId),
      ),
    )
    .catch(rethrowQueryFailure);
  return row === undefined ? null : projectVersion(row);
}

export async function listVersions(
  client: PoolClient,
  scope: FolderScope,
  input: ListWorkflowVersionsInput,
) {
  if (
    !(await workflowAccessible(client, scope, {
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
    }))
  )
    throw new WorkflowNotFoundError('Workflow is not visible');
  const workflowId = input.workflowId;
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
  const limit = input.limit ?? 50;
  const beforeVersionNumber = input.beforeVersionNumber ?? null;
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
}
