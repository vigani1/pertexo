import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { lockWorkspaceRunAdmission } from '../../shared/workspace-fence.repository.js';
import { PreviewAttemptStateError } from '../preview.errors.js';

/** Workspace precedes preview locks, serializing new work against deletion. */
export async function requireActivePreviewWorkspace(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  if (
    (await lockWorkspaceRunAdmission(drizzle(client), workspaceId)) !== 'active'
  )
    throw new PreviewAttemptStateError('workspace_unavailable');
}
