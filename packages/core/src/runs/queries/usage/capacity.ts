import { BROWSABLE_WORKSPACE_STATUSES, hasCapability } from '@pertexo/policy';
import type { Pool, PoolClient } from 'pg';
import { WorkspaceAccessDeniedError } from '../../../shared/access/workspace-access.errors.js';
import {
  withWorkspaceAccess,
  type WorkspaceActor,
} from '../../../shared/access/workspace-access.js';
import { capacityQuery, type PolicyState } from './capacity.repository.js';

/** A usage read's statement budget: capacity and trends scan bounded ranges. */
export const USAGE_READ_STATEMENT_TIMEOUT_MILLIS = 2_000;
export type WorkspaceUsageCapacityInput = WorkspaceActor;
// Read projection combines stored columns with computed or joined fields.
export type WorkspaceUsageCapacityRecord = Readonly<{
  asOf: string;
  execution: Readonly<{
    activeRuns: number;
    reservedActiveSlots: number;
    activeCapacityConsumed: number;
    queuedRuns: number;
    policy: Readonly<{
      state: PolicyState;
      version: number | null;
      activeRunLimit: number | null;
      queuedRunLimit: number | null;
    }>;
  }>;
  artifacts: Readonly<{
    chargedBytes: string;
    byteLimit: string;
    chargedCount: number;
    artifactCountLimit: number;
    source: 'stored' | 'default';
  }>;
}>;

/** ADR 057: current resource capacity, not historical or billable usage. */
export function readWorkspaceUsageCapacity(
  pool: Pool,
  input: WorkspaceUsageCapacityInput,
): Promise<WorkspaceUsageCapacityRecord> {
  return withWorkspaceAccess(
    pool,
    input,
    {
      mode: 'read',
      capability: 'run:read',
      statuses: BROWSABLE_WORKSPACE_STATUSES,
      statementTimeoutMillis: USAGE_READ_STATEMENT_TIMEOUT_MILLIS,
    },
    async (client, role) => {
      // Both today's roles hold both; the rule stays visible if they ever differ.
      if (!hasCapability(role, 'artifact:read'))
        throw new WorkspaceAccessDeniedError();
      return readCapacitySnapshot(client, input.workspaceId);
    },
  );
}

/** The snapshot itself, in a transaction whose caller has settled authority. */
export async function readCapacitySnapshot(
  client: PoolClient,
  workspaceId: string,
): Promise<WorkspaceUsageCapacityRecord> {
  const [row] = await capacityQuery(client, workspaceId);
  if (row === undefined) throw new WorkspaceAccessDeniedError();
  return Object.freeze({
    asOf: row.as_of,
    execution: Object.freeze({
      activeRuns: row.active_runs,
      reservedActiveSlots: row.reserved_active_slots,
      activeCapacityConsumed: row.active_runs + row.reserved_active_slots,
      queuedRuns: row.queued_runs,
      policy: Object.freeze({
        state: row.policy_state,
        version: row.version,
        activeRunLimit: row.active_run_limit,
        queuedRunLimit: row.queued_run_limit,
      }),
    }),
    artifacts: Object.freeze({
      chargedBytes: row.charged_bytes,
      byteLimit: row.byte_limit,
      chargedCount: row.charged_count,
      artifactCountLimit: row.artifact_count_limit,
      source: row.capacity_source,
    }),
  });
}
