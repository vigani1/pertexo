import { isAdministrativeRole } from '@pertexo/workflow-model';
import type { AudienceReview } from '@pertexo/contracts';
import { requireMoveAudienceReview } from './sharing/audience.queries.js';
import { readFolderScope } from '../../tenant-access/resources/facts.queries.js';
import { workflowAccessible } from '../../tenant-access/resources/workflows.queries.js';
import type { PoolClient } from 'pg';
import type { Role } from '@pertexo/workflow-model';

import { WorkflowNotFoundError } from '../workflows/errors.js';
import type { OrganizationScope } from './commands.repository.js';
import {
  WorkflowFolderConflictError,
  WorkflowTagConflictError,
} from './errors.js';

export type OrganizationChange =
  | Readonly<{
      kind: 'move';
      folderId: string | null;
      audienceReview?: AudienceReview | undefined;
    }>
  | Readonly<{ kind: 'replace_tags'; tagIds: readonly string[] }>
  | Readonly<{ kind: 'detach_tag'; tagId: string }>;

/**
 * Archived workflows keep their tags; only administrators move them between
 * folders. Tag detach is cleanup and works on any workflow.
 */
function checkLifecycle(
  role: Role | null,
  lifecycleStatus: string,
  kind: OrganizationChange['kind'],
): void {
  if (lifecycleStatus === 'active' || kind === 'detach_tag') return;
  const administratorMove =
    kind === 'move' && role !== null && isAdministrativeRole(role);
  if (administratorMove) return;
  throw new WorkflowTagConflictError('lifecycle');
}

/**
 * Changes one workflow's folder or tags when its organization revision
 * matches, and returns the advanced revision. The caller holds the
 * organization lock.
 */
export async function organizeWorkflow(
  client: PoolClient,
  scope: OrganizationScope,
  input: Readonly<{
    workflowId: string;
    change: OrganizationChange;
    expectedOrganizationRevision: number;
  }>,
): Promise<number> {
  const { change, workflowId } = input;
  const access = await readFolderScope(client, scope);
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
    if (change.folderId !== null) {
      const folder = await client.query(
        'select 1 from app.workflow_folders where workspace_id = $1 and id = $2',
        [scope.workspaceId, change.folderId],
      );
      if (folder.rowCount !== 1)
        throw new WorkflowFolderConflictError('not_visible');
    }
  } else {
    const tagIds =
      change.kind === 'replace_tags' ? change.tagIds : [change.tagId];
    const tags = await client.query<{ count: number }>(
      `select count(*)::int count from app.workflow_tags
       where workspace_id = $1 and id = any($2::uuid[])`,
      [scope.workspaceId, tagIds],
    );
    if (tags.rows[0]?.count !== tagIds.length)
      throw new WorkflowNotFoundError('Workflow is not visible');
  }
  const workflow = await client.query<{ lifecycle_status: string }>(
    `select lifecycle_status from app.workflows
     where workspace_id = $1 and id = $2 for update`,
    [scope.workspaceId, workflowId],
  );
  const lifecycleStatus = workflow.rows[0]?.lifecycle_status;
  if (lifecycleStatus === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  checkLifecycle(access.role, lifecycleStatus, change.kind);

  const state = await client.query<{ revision: string }>(
    `select revision from app.workflow_organization_state
     where workspace_id = $1 and workflow_id = $2`,
    [scope.workspaceId, workflowId],
  );
  // A workflow without organization state is at revision 1.
  const revision = Number(state.rows[0]?.revision ?? 1);
  if (revision !== input.expectedOrganizationRevision)
    throw new WorkflowTagConflictError('organization_revision');

  if (change.kind === 'replace_tags') {
    await client.query(
      `delete from app.workflow_tag_assignments
       where workspace_id = $1 and workflow_id = $2`,
      [scope.workspaceId, workflowId],
    );
    await client.query(
      `insert into app.workflow_tag_assignments (workspace_id, workflow_id, tag_id)
       select $1, $2, tag_id from unnest($3::uuid[]) tag_id`,
      [scope.workspaceId, workflowId, change.tagIds],
    );
  } else if (change.kind === 'detach_tag') {
    await client.query(
      `delete from app.workflow_tag_assignments
       where workspace_id = $1 and workflow_id = $2 and tag_id = $3`,
      [scope.workspaceId, workflowId, change.tagId],
    );
  }
  await client.query(
    `insert into app.workflow_organization_state
       (workspace_id, workflow_id, revision, folder_id)
     values ($1, $2, $3, $4)
     on conflict (workspace_id, workflow_id) do update
     set revision = excluded.revision,
         folder_id = case when $5 then excluded.folder_id
                          else app.workflow_organization_state.folder_id end`,
    [
      scope.workspaceId,
      workflowId,
      revision + 1,
      change.kind === 'move' ? change.folderId : null,
      change.kind === 'move',
    ],
  );
  return revision + 1;
}

/**
 * An earlier result is answered only while the workflow is still visible
 * and, for an archived workflow's move, the actor is still an administrator.
 */
export async function checkOrganizationReplay(
  client: PoolClient,
  scope: OrganizationScope,
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
  const access = await readFolderScope(client, scope);
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
  const workflow = await client.query<{ lifecycle_status: string }>(
    `select lifecycle_status from app.workflows
     where workspace_id = $1 and id = $2 for share`,
    [scope.workspaceId, workflowId],
  );
  const lifecycleStatus = workflow.rows[0]?.lifecycle_status;
  if (lifecycleStatus === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  if (kind === 'move') checkLifecycle(access.role, lifecycleStatus, kind);
}
