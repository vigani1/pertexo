import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflows,
  workflowFolders,
  workflowTags,
  workflowOrganizationState,
  workflowTagAssignments,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { isAdministrativeRole } from '@pertexo/workflow-model';
import type { AudienceReview } from '@pertexo/contracts';
import { requireMoveAudienceReview } from './sharing/audience.queries.js';
import { readFolderScope } from '../../shared/facts.queries.js';
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
      const folder = await drizzle(client)
        .select({ id: workflowFolders.id })
        .from(workflowFolders)
        .where(
          and(
            eq(workflowFolders.workspaceId, scope.workspaceId),
            eq(workflowFolders.id, change.folderId),
          ),
        )
        .catch(rethrowQueryFailure);
      if (folder.length !== 1)
        throw new WorkflowFolderConflictError('not_visible');
    }
  } else {
    const tagIds =
      change.kind === 'replace_tags' ? change.tagIds : [change.tagId];
    const [tags] = await drizzle(client)
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowTags)
      .where(
        and(
          eq(workflowTags.workspaceId, scope.workspaceId),
          inArray(workflowTags.id, tagIds),
        ),
      )
      .catch(rethrowQueryFailure);
    if (tags?.count !== tagIds.length)
      throw new WorkflowNotFoundError('Workflow is not visible');
  }
  const [workflow] = await drizzle(client)
    .select({ lifecycleStatus: workflows.lifecycleStatus })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, scope.workspaceId),
        eq(workflows.id, workflowId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const lifecycleStatus = workflow?.lifecycleStatus;
  if (lifecycleStatus === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  checkLifecycle(access.role, lifecycleStatus, change.kind);

  const [state] = await drizzle(client)
    .select({ revision: workflowOrganizationState.revision })
    .from(workflowOrganizationState)
    .where(
      and(
        eq(workflowOrganizationState.workspaceId, scope.workspaceId),
        eq(workflowOrganizationState.workflowId, workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  // A workflow without organization state is at revision 1.
  const revision = state?.revision ?? 1;
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
  const [workflow] = await drizzle(client)
    .select({ lifecycleStatus: workflows.lifecycleStatus })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, scope.workspaceId),
        eq(workflows.id, workflowId),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  const lifecycleStatus = workflow?.lifecycleStatus;
  if (lifecycleStatus === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  if (kind === 'move') checkLifecycle(access.role, lifecycleStatus, kind);
}

async function persistPlacement(
  client: PoolClient,
  scope: OrganizationScope,
  {
    workflowId,
    change,
    revision,
  }: Readonly<{
    workflowId: string;
    change: OrganizationChange;
    revision: number;
  }>,
): Promise<void> {
  const db = drizzle(client);
  const assignmentScope = and(
    eq(workflowTagAssignments.workspaceId, scope.workspaceId),
    eq(workflowTagAssignments.workflowId, workflowId),
  );
  if (change.kind === 'replace_tags') {
    await db
      .delete(workflowTagAssignments)
      .where(assignmentScope)
      .catch(rethrowQueryFailure);
    if (change.tagIds.length > 0)
      await db
        .insert(workflowTagAssignments)
        .values(
          change.tagIds.map((tagId) => ({
            workspaceId: scope.workspaceId,
            workflowId,
            tagId,
          })),
        )
        .catch(rethrowQueryFailure);
  } else if (change.kind === 'detach_tag') {
    await db
      .delete(workflowTagAssignments)
      .where(
        and(assignmentScope, eq(workflowTagAssignments.tagId, change.tagId)),
      )
      .catch(rethrowQueryFailure);
  }
  await db
    .insert(workflowOrganizationState)
    .values({
      workspaceId: scope.workspaceId,
      workflowId,
      revision,
      folderId: change.kind === 'move' ? change.folderId : null,
    })
    .onConflictDoUpdate({
      target: [
        workflowOrganizationState.workspaceId,
        workflowOrganizationState.workflowId,
      ],
      set: {
        revision: sql`excluded.revision`,
        ...(change.kind === 'move'
          ? { folderId: sql`excluded.folder_id` }
          : { folderId: workflowOrganizationState.folderId }),
      },
    })
    .catch(rethrowQueryFailure);
}
