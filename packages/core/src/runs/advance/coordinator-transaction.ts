import {
  enterRunAdmissionProtocol,
  lockWorkspaceRunAdmission,
} from '../../shared/workspace-fence.repository.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import type { Pool, PoolClient } from 'pg';

export function assertCoordinatorNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('The operation was aborted', 'AbortError');
}

/** A delivery or worker action: no member behind it, so it stays off withWorkspaceAccess. */
export function withCoordinatorWriteClient<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertCoordinatorNotAborted(signal);
  return withTenantScopedClient(
    pool,
    { workspaceId },
    async (client) => {
      await enterRunAdmissionProtocol(drizzle(client));
      // Lifecycle/purge holds workspace before run rows. Acquire the shared
      // workspace lock before any coordinator run/checkpoint lock or FK write.
      await lockWorkspaceRunAdmission(drizzle(client), workspaceId);
      return operation(client);
    },
    { signal },
  );
}
