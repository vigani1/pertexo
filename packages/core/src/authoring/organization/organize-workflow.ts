import type { AudienceReview } from '@pertexo/contracts';
import { requireMoveAudienceReview } from './sharing/audience.js';
import { readFolderScope } from '../../shared/access/folder-access-facts.repository.js';
import { workflowAccessible } from '../../shared/resources/workflow-access.repository.js';
import type { PoolClient } from 'pg';
import type { Role } from '@pertexo/policy';
import {
  countWorkspaceTags,
  folderExists,
  lockWorkflowLifecycle,
  persistPlacement,
  readOrganizationRevision,
} from './workflow-placements.repository.js';
import { lifecycleAllowsChange } from './placement.js';

import { WorkflowNotFoundError } from '../workflows/workflow-authoring.errors.js';
import type { OrganizationActor } from './session.js';
import {
  WorkflowFolderConflictError,
  WorkflowTagConflictError,
} from './workflow-organization.errors.js';

export type OrganizationChange =
  | Readonly<{
      kind: 'move';
      folderId: string | null;
      audienceReview?: AudienceReview | undefined;
    }>
  | Readonly<{ kind: 'replace_tags'; tagIds: readonly string[] }>
  | Readonly<{ kind: 'detach_tag'; tagId: string }>;

function checkLifecycle(
  role: Role | null,
  lifecycleStatus: string,
  kind: OrganizationChange['kind'],
): void {
  if (!lifecycleAllowsChange(role, lifecycleStatus, kind))
    throw new WorkflowTagConflictError('lifecycle');
}

/**
 * Changes one workflow's folder or tags when its organization revision
 * matches, and returns the advanced revision. The caller holds the
 * organization lock.
 */
export async function organizeWorkflow(
  client: PoolClient,
  scope: OrganizationActor,
  input: Readonly<{
    workflowId: string;
    change: OrganizationChange;
    expectedOrganizationRevision: number;
  }>,
): Promise<number> {
  const { change, workflowId } = input;
  const access = await readFolderScope(client, scope, scope.role);
  if (
    !(await workflowAccessible(client, access, {
      workspaceId: scope.workspaceId,
      workflowId,
      capability: 'workflow:update',
    }))
  )
    throw new WorkflowNotFoundError('Workflow is not visible');
  if (
    change.kind === 'move' &&
    !access.permits(change.folderId, 'workflow:create')
  )
    throw new WorkflowFolderConflictError('not_visible');
  if (change.kind === 'move') {
    await requireMoveAudienceReview(
      client,
      scope,
      {
        kind: 'workflows',
        workflowIds: [workflowId],
        destinationFolderId: change.folderId,
      },
      change.audienceReview,
    );
    if (
      change.folderId !== null &&
      !(await folderExists(client, scope.workspaceId, change.folderId))
    )
      throw new WorkflowFolderConflictError('not_visible');
  } else {
    const tagIds =
      change.kind === 'replace_tags' ? change.tagIds : [change.tagId];
    const tags = await countWorkspaceTags(client, scope.workspaceId, tagIds);
    if (tags !== tagIds.length)
      throw new WorkflowNotFoundError('Workflow is not visible');
  }
  const lifecycleStatus = await lockWorkflowLifecycle(client, {
    workspaceId: scope.workspaceId,
    workflowId,
    strength: 'update',
  });
  if (lifecycleStatus === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  checkLifecycle(access.role, lifecycleStatus, change.kind);

  // A workflow without organization state is at revision 1.
  const revision =
    (await readOrganizationRevision(client, scope.workspaceId, workflowId)) ??
    1;
  if (revision !== input.expectedOrganizationRevision)
    throw new WorkflowTagConflictError('organization_revision');

  await persistPlacement(client, scope, {
    workflowId,
    change,
    revision: revision + 1,
  });
  return revision + 1;
}

/**
 * An earlier result is answered only while the workflow is still visible
 * and, for an archived workflow's move, the actor is still an administrator.
 */
export async function checkOrganizationReplay(
  client: PoolClient,
  scope: OrganizationActor,
  {
    workflowId,
    kind,
    destinationFolderId,
  }: Readonly<{
    workflowId: string;
    kind: OrganizationChange['kind'];
    destinationFolderId?: (string | null) | undefined;
  }>,
): Promise<void> {
  const access = await readFolderScope(client, scope, scope.role);
  if (
    !(await workflowAccessible(client, access, {
      workspaceId: scope.workspaceId,
      workflowId,
      capability: 'workflow:update',
    }))
  )
    throw new WorkflowNotFoundError('Workflow is not visible');
  const destinationRefused =
    kind === 'move' &&
    destinationFolderId !== undefined &&
    !access.permits(destinationFolderId, 'workflow:create');
  if (destinationRefused) throw new WorkflowFolderConflictError('not_visible');
  const lifecycleStatus = await lockWorkflowLifecycle(client, {
    workspaceId: scope.workspaceId,
    workflowId,
    strength: 'share',
  });
  if (lifecycleStatus === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  if (kind === 'move') checkLifecycle(access.role, lifecycleStatus, kind);
}
