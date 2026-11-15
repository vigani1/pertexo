import { WORKFLOW_FOLDER_LIMITS } from '@pertexo/workflow-model';

import type { PoolClient } from 'pg';

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { drizzle } from 'drizzle-orm/node-postgres';

import {
  workflowFolders,
  workflowOrganizationState,
  workflows,
} from '@pertexo/database/schema';

import { rethrowQueryFailure } from '@pertexo/database/primitives';

import type { FolderScope } from '../../../shared/folder-access.types.js';

import type { WorkflowMoveReviewRequest } from '@pertexo/contracts';
import { workflowScopeSql } from '../../../shared/folder-scope.repository.js';

import type { OrganizationActor } from '../session.js';

export function readMoveFolders(client: PoolClient, workspaceId: string) {
  // Keep the signed token's wire fields and bigint text representation unchanged.
  return drizzle(client)
    .select({
      id: workflowFolders.id,
      name: workflowFolders.name,
      parent_id: workflowFolders.parentId,
      revision: sql<string>`${workflowFolders.revision}::text`,
      access_mode: workflowFolders.accessMode,
    })
    .from(workflowFolders)
    .where(eq(workflowFolders.workspaceId, workspaceId))
    .orderBy(asc(workflowFolders.id))
    .limit(WORKFLOW_FOLDER_LIMITS.foldersPerWorkspace + 1)
    .catch(rethrowQueryFailure);
}

/** The workflows to move, with their folder and organization revision, that the actor may update. */
export async function readWorkflowSources(
  client: PoolClient,
  actor: OrganizationActor,
  request: Extract<WorkflowMoveReviewRequest, { kind: 'workflows' }>,
  scope: FolderScope,
) {
  const sources = await drizzle(client)
    .select({
      id: workflows.id,
      folder_id: workflowOrganizationState.folderId,
      revision: sql<number>`coalesce(${workflowOrganizationState.revision},1)::int`,
    })
    .from(workflows)
    .leftJoin(
      workflowOrganizationState,
      and(
        eq(workflowOrganizationState.workspaceId, workflows.workspaceId),
        eq(workflowOrganizationState.workflowId, workflows.id),
      ),
    )
    .where(
      and(
        eq(workflows.workspaceId, actor.workspaceId),
        inArray(workflows.id, request.workflowIds),
        workflowScopeSql(scope, sql`${workflows.id}`, 'workflow:update'),
      ),
    )
    .orderBy(asc(workflows.id))
    .catch(rethrowQueryFailure);
  return sources;
}
