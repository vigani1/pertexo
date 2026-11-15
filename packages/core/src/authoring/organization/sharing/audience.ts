import { WORKFLOW_FOLDER_LIMITS } from '@pertexo/workflow-model';

import { folderAudienceFingerprint } from './audience-digests.js';

import type { PoolClient } from 'pg';

import type { FolderScope } from '../../../shared/folder-access.types.js';

import type {
  AudienceReview,
  WorkflowMoveReviewRequest,
  WorkflowMoveReview,
  WorkflowMoveReviewItem,
} from '@pertexo/contracts';

import { readFolderScope } from '../../../shared/folder-access-facts.repository.js';

import {
  RESOURCE_ADMINISTRATORS,
  removesFolderRestriction,
} from '../../../shared/folder-policy.js';

import { WorkflowNotFoundError } from '../../workflows/workflow-authoring.errors.js';

import { WorkflowFolderConflictError } from '../workflow-organization.errors.js';

import type { OrganizationActor } from '../session.js';

import { readMoveFolders, readWorkflowSources } from './audience.repository.js';

/** Review restriction identities, rather than guessing whether two groups' future members coincide. */
export async function reviewMoveAudience(
  client: PoolClient,
  actor: OrganizationActor,
  request: WorkflowMoveReviewRequest,
): Promise<WorkflowMoveReview> {
  const scope = await readFolderScope(client, actor, actor.role);
  const folders = await readMoveFolders(client, actor.workspaceId);
  if (folders.length > WORKFLOW_FOLDER_LIMITS.foldersPerWorkspace)
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
      token: folderAudienceFingerprint({
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

export async function readMoveSources(
  client: PoolClient,
  {
    actor,
    request,
    scope,
    folders,
  }: Readonly<{
    actor: OrganizationActor;
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
  const sources = await readWorkflowSources(client, actor, request, scope);
  if (sources.length !== request.workflowIds.length)
    throw new WorkflowNotFoundError('Workflow is not visible');
  return sources;
}

export async function requireMoveAudienceReview(
  client: PoolClient,
  actor: OrganizationActor,
  request: WorkflowMoveReviewRequest,
  review: AudienceReview | undefined,
): Promise<void> {
  const current = (await reviewMoveAudience(client, actor, request)).items[0];
  if (!current?.requiresReview) return;
  const scope = await readFolderScope(client, actor, actor.role);
  const audienceReviewRefused =
    scope.role === null ||
    !RESOURCE_ADMINISTRATORS.includes(scope.role) ||
    !review?.acknowledge ||
    review.token !== current.token;
  if (audienceReviewRefused)
    throw new WorkflowFolderConflictError('audience_review');
}
