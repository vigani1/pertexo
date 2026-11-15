import { requireActivePreviewWorkspace } from './workspace-fence.repository.js';
import type { Pool } from 'pg';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { extendPreviewLease } from './lease.repository.js';
import type {
  HeartbeatPreviewLeaseInput,
  PreviewHeartbeatResult,
} from './preview-attempt.types.js';

import { PreviewAttemptStateError } from '../preview.errors.js';

export async function heartbeatPreviewLease(
  pool: Pool,
  input: HeartbeatPreviewLeaseInput,
): Promise<PreviewHeartbeatResult> {
  const scope = {
    ...input.lease,
    leaseDurationSeconds: input.leaseDurationSeconds,
    workerId: input.workerId,
  };
  return withTenantScopedClient(
    pool,
    { workspaceId: scope.workspaceId },
    async (client) => {
      await requireActivePreviewWorkspace(client, scope.workspaceId);
      const row = await extendPreviewLease(client, scope);
      if (row === undefined)
        throw new PreviewAttemptStateError('heartbeat_lost');
      return Object.freeze({
        attemptLeaseExpiresAt: row.attemptLeaseExpiresAt,
        runExecutionDeadlineAt: row.runExecutionDeadlineAt,
      });
    },
    input,
  );
}
