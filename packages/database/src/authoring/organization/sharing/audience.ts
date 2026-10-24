import type { PoolClient } from 'pg';
import { sql } from 'drizzle-orm';
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
import {
  bindResourcePredicate,
  workflowScopeSql,
} from '../../../tenant-access/resources/scope.queries.js';
import { WorkflowNotFoundError } from '../../workflows/errors.js';
import { WorkflowFolderConflictError } from '../errors.js';
import type { OrganizationScope } from '../command.js';
import { FOLDER_LIMIT } from '../limits.js';

/** Review restriction identities, rather than guessing whether two groups' future members coincide. */
export async function reviewMoveAudience(
  client: PoolClient,
  actor: OrganizationScope,
  request: WorkflowMoveReviewRequest,
): Promise<WorkflowMoveReview> {
  const scope = await readFolderScope(client, actor);
  const folders = (
    await client.query<{
      id: string;
      name: string;
      parent_id: string | null;
      revision: number;
      access_mode: string;
    }>(
      'select id,name,parent_id,revision,access_mode from app.workflow_folders where workspace_id=$1 order by id limit $2',
      [actor.workspaceId, FOLDER_LIMIT + 1],
    )
  ).rows;
  if (folders.length > FOLDER_LIMIT)
    throw new Error('Folder hierarchy exceeds its bound');
  if (!scope.permits(request.destinationFolderId, 'workflow:create'))
    throw new WorkflowNotFoundError('Folder is not visible');
  let sources: { id: string; folder_id: string | null; revision: number }[];
  if (request.kind === 'folder') {
    if (scope.role === null || !RESOURCE_ADMINISTRATORS.includes(scope.role))
      throw new WorkflowNotFoundError('Folder is not visible');
    const folder = folders.find((folder) => folder.id === request.folderId);
    if (folder === undefined)
      throw new WorkflowNotFoundError('Folder is not visible');
    sources = [
      { id: folder.id, folder_id: folder.parent_id, revision: folder.revision },
    ];
  } else {
    const parameters: unknown[] = [actor.workspaceId, request.workflowIds];
    const visible = bindResourcePredicate(
      workflowScopeSql(scope, sql`workflow.id`, 'workflow:update'),
      parameters,
    );
    sources = (
      await client.query<{
        id: string;
        folder_id: string | null;
        revision: number;
      }>(
        `select workflow.id,state.folder_id,coalesce(state.revision,1)::int revision
      from app.workflows workflow left join app.workflow_organization_state state on state.workspace_id=workflow.workspace_id and state.workflow_id=workflow.id
      where workflow.workspace_id=$1 and workflow.id=any($2::uuid[]) and ${visible} order by workflow.id`,
        parameters,
      )
    ).rows;
    if (sources.length !== request.workflowIds.length)
      throw new WorkflowNotFoundError('Workflow is not visible');
  }
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
