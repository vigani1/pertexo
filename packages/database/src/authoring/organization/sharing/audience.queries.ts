import type { PoolClient } from 'pg';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflowFolders,
  workflowOrganizationState,
} from '../../../schema/authoring/organization.js';
import { workflows } from '../../../schema/authoring/workflows.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { FolderScope } from '../../../tenant-access/resources/contract.js';
import type {
  AudienceReview,
  WorkflowMoveReviewRequest,
  WorkflowMoveReview,
  WorkflowMoveReviewItem,
} from '@pertexo/contracts';
import { canonicalOutboxPayloadChecksum } from '../../../outbox/events.repository.js';
import { readFolderScope } from '../../../tenant-access/resources/facts.queries.js';
import {
  RESOURCE_ADMINISTRATORS,
  removesFolderRestriction,
} from '../../../tenant-access/resources/policy.js';
import { workflowScopeSql } from '../../../tenant-access/resources/query-scope.js';
import { WorkflowNotFoundError } from '../../workflows/errors.js';
import { WorkflowFolderConflictError } from '../errors.js';
import type { OrganizationScope } from '../commands.repository.js';
import { FOLDER_LIMIT } from '../limits.js';

/** Review restriction identities, rather than guessing whether two groups' future members coincide. */
export async function reviewMoveAudience(
  client: PoolClient,
  actor: OrganizationScope,
  request: WorkflowMoveReviewRequest,
): Promise<WorkflowMoveReview> {
  const scope = await readFolderScope(client, actor);
  const folders = await readMoveFolders(client, actor.workspaceId);
  if (folders.length > FOLDER_LIMIT)
    throw new Error('Folder hierarchy exceeds its bound');
  if (!scope.permits(request.destinationFolderId, 'workflow:create'))
    throw new WorkflowNotFoundError('Folder is not visible');
  const sources = await readMoveSources(client, {
    actor,
    request,
    scope,
    folders,
  });
  const destination = scope.restrictions(request.destinationFolderId);
  const items: WorkflowMoveReviewItem[] = sources.map((source) => {
    const original = scope.restrictions(source.folder_id);
    const removed = new Set(original.filter((id) => !destination.includes(id)));
    return {
      id: source.id,
      requiresReview: removesFolderRestriction(original, destination),
      token: canonicalOutboxPayloadChecksum({
        workspaceId: actor.workspaceId,
        kind: request.kind,
        source,
        destinationFolderId: request.destinationFolderId,
        folders,
      }),
      removedRestrictions: folders
        .filter((folder) => removed.has(folder.id))
        .map(({ id, name }) => ({ id, name })),
    };
  });
  return { items };
}

function readMoveFolders(client: PoolClient, workspaceId: string) {
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
    .limit(FOLDER_LIMIT + 1)
    .catch(rethrowQueryFailure);
}

async function readMoveSources(
  client: PoolClient,
  {
    actor,
    request,
    scope,
    folders,
  }: Readonly<{
    actor: OrganizationScope;
    request: WorkflowMoveReviewRequest;
    scope: FolderScope;
    folders: Awaited<ReturnType<typeof readMoveFolders>>;
  }>,
) {
  if (request.kind === 'folder') {
    if (scope.role === null || !RESOURCE_ADMINISTRATORS.includes(scope.role))
      throw new WorkflowNotFoundError('Folder is not visible');
    const folder = folders.find((folder) => folder.id === request.folderId);
    if (folder === undefined)
      throw new WorkflowNotFoundError('Folder is not visible');
    return [
      { id: folder.id, folder_id: folder.parent_id, revision: folder.revision },
    ];
  }
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
  if (sources.length !== request.workflowIds.length)
    throw new WorkflowNotFoundError('Workflow is not visible');
  return sources;
}

export async function requireMoveAudienceReview(
  client: PoolClient,
  actor: OrganizationScope,
  request: WorkflowMoveReviewRequest,
  review: AudienceReview | undefined,
): Promise<void> {
  const current = (await reviewMoveAudience(client, actor, request)).items[0];
  if (!current?.requiresReview) return;
  const scope = await readFolderScope(client, actor);
  const audienceReviewRefused =
    scope.role === null ||
    !RESOURCE_ADMINISTRATORS.includes(scope.role) ||
    !review?.acknowledge ||
    review.token !== current.token;
  if (audienceReviewRefused)
    throw new WorkflowFolderConflictError('audience_review');
}
