import type { WorkflowRef } from '../../../shared/workflow-actor.types.js';
import { and, desc, eq, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workflows, workflowVersions } from '@pertexo/database/schema';
import {
  projectVersion,
  versionProjection,
} from '../representation/workflow-representations.repository.js';
import type { PoolClient } from 'pg';
import type { FolderScope } from '../../../shared/folder-access.types.js';
import { workflowAccessible } from '../../../shared/resources/workflow-access.repository.js';
import type { ListWorkflowVersionsInput } from '../workflow-commands.types.js';

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

export async function workflowExists(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
): Promise<boolean> {
  const visible = await drizzle(client)
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .catch(rethrowQueryFailure);
  return visible.length === 1;
}

/** Newest first before the cursor, one past `limit` so a next page shows. */
export async function readVersionPage(
  client: PoolClient,
  input: ListWorkflowVersionsInput,
  {
    limit,
    beforeVersionNumber,
  }: Readonly<{ limit: number; beforeVersionNumber: number | null }>,
) {
  const workflowId = input.workflowId;
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
  return result;
}
