import { BROWSABLE_WORKSPACE_STATUSES, hasCapability } from '@pertexo/policy';
import { entitlementPolicyState } from '../entitlement-effect.js';
import {
  DEFAULT_ARTIFACT_BYTE_LIMIT,
  workspaceArtifactCapacity,
  workspaceExecutionEntitlementVersions,
  workspaceExecutionEntitlements,
  workspaceExecutionAdmissionCounters,
  workspaces,
} from '@pertexo/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { WorkspaceAccessDeniedError } from '../../../shared/workspace-access.errors.js';
import {
  withWorkspaceAccess,
  type WorkspaceActor,
} from '../../../shared/workspace-access.js';
type PolicyState =
  'active' | 'suspended' | 'not_yet_effective' | 'expired' | 'unavailable';

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
      statementTimeoutMillis: 2_000,
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

function capacityQuery(client: PoolClient, workspaceId: string) {
  return drizzle(client)
    .select({
      as_of: sql<string>`to_char(transaction_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      active_runs: sql<number>`current_runs.active_runs`,
      queued_runs: sql<number>`current_runs.queued_runs`,
      reserved_active_slots: sql<number>`current_runs.reserved_active_slots`,
      policy_state: sql<PolicyState>`case when ${workspaceExecutionEntitlementVersions.version} is null or ${workspaceExecutionAdmissionCounters.workspaceId} is null then 'unavailable' else ${entitlementPolicyState(workspaceExecutionEntitlementVersions, sql`transaction_timestamp()`)} end`,
      version: workspaceExecutionEntitlementVersions.version,
      active_run_limit: workspaceExecutionEntitlementVersions.activeRunLimit,
      queued_run_limit: workspaceExecutionEntitlementVersions.queuedRunLimit,
      charged_bytes: sql<string>`coalesce(${workspaceArtifactCapacity.chargedBytes},0)::text`,
      byte_limit: sql<string>`coalesce(${workspaceArtifactCapacity.byteLimit},${sql.raw(String(DEFAULT_ARTIFACT_BYTE_LIMIT))})::text`,
      charged_count: sql<number>`coalesce(${workspaceArtifactCapacity.chargedCount},0)`,
      artifact_count_limit: sql<number>`coalesce(${workspaceArtifactCapacity.artifactCountLimit},app.instance_artifact_count_limit())`,
      capacity_source: sql<
        'default' | 'stored'
      >`case when ${workspaceArtifactCapacity.workspaceId} is null then 'default' else 'stored' end`,
    })
    .from(workspaces)
    .crossJoin(
      sql`app.workflow_run_slot_counts(${workspaceId}::uuid) current_runs`,
    )
    .leftJoin(
      workspaceExecutionEntitlements,
      eq(workspaceExecutionEntitlements.workspaceId, workspaceId),
    )
    .leftJoin(
      workspaceExecutionEntitlementVersions,
      and(
        eq(
          workspaceExecutionEntitlementVersions.workspaceId,
          workspaceExecutionEntitlements.workspaceId,
        ),
        eq(
          workspaceExecutionEntitlementVersions.version,
          workspaceExecutionEntitlements.currentVersion,
        ),
      ),
    )
    .leftJoin(
      workspaceExecutionAdmissionCounters,
      eq(workspaceExecutionAdmissionCounters.workspaceId, workspaceId),
    )
    .leftJoin(
      workspaceArtifactCapacity,
      eq(workspaceArtifactCapacity.workspaceId, workspaceId),
    )
    .where(eq(workspaces.id, workspaceId));
}
