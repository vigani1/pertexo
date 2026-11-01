import { ALL_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import type { Pool } from 'pg';

import { withWorkspaceAccess } from '../../shared/workspace-access.js';
import {
  WorkspaceAccessDeniedError,
  WorkspaceLifecycleConflictError,
} from '../../tenant-access/errors.js';
import { applyWorkspaceLifecycleChange } from './apply.repository.js';
import type {
  WorkspaceLifecycleChange,
  WorkspaceLifecycleOperation,
} from './contract.js';

/**
 * Only the owner changes a workspace's lifecycle, one change at a time, and the
 * flow updates the workspace row, so it takes that row first. Every status is
 * let through because the transition decides whether a command applies, and an
 * exact retry gets its receipt whatever has happened to the workspace since.
 */
export async function changeWorkspaceLifecycle(
  pool: Pool,
  change: WorkspaceLifecycleChange,
): Promise<WorkspaceLifecycleOperation> {
  try {
    return await withWorkspaceAccess(
      pool,
      { workspaceId: change.workspaceId, actorId: change.actorUserId },
      {
        mode: 'exclusive',
        capability: 'workspace:manage',
        statuses: ALL_WORKSPACE_STATUSES,
      },
      (client) => applyWorkspaceLifecycleChange(client, change),
    );
  } catch (error: unknown) {
    if (error instanceof WorkspaceAccessDeniedError)
      throw new WorkspaceLifecycleConflictError(
        'actor_inactive',
        'Workspace lifecycle actor is not authorized',
      );
    throw error;
  }
}
