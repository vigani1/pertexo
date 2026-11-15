import { withTenantScopedClient } from '@pertexo/database/primitives';
import { attemptControl } from '../control.js';
import type { Pool } from 'pg';
import { extendAttemptLease } from './lease.repository.js';
import { NodeAttemptReconciliationRequiredError } from '../node-attempt.errors.js';
import type { HeartbeatInput, NodeAttemptHeartbeat } from '../node-attempt.js';

export async function heartbeatNodeAttempt(
  pool: Pool,
  input: HeartbeatInput,
): Promise<NodeAttemptHeartbeat> {
  return withTenantScopedClient(
    pool,
    { workspaceId: input.lease.workspaceId },
    async (client) => {
      const row = await extendAttemptLease(client, input);
      if (row === undefined) throw new NodeAttemptReconciliationRequiredError();
      return Object.freeze({
        leaseExpiresAt: row.leaseExpiresAt,
        control: attemptControl(row.abortReason),
      });
    },
    { signal: input.signal },
  );
}
