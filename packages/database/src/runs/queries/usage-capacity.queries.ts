import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import { entitlementPolicyState } from './entitlement-effect.js';
import {
  DEFAULT_ARTIFACT_BYTE_LIMIT,
  DEFAULT_ARTIFACT_COUNT_LIMIT,
  workspaceArtifactCapacity,
} from '../../schema/transport.js';
import {
  workspaceExecutionEntitlementVersions,
  workspaceExecutionEntitlements,
} from '../../schema/runs/capacity/entitlements.js';
import { workspaceExecutionAdmissionCounters } from '../../schema/runs/capacity/admission.js';
import { workspaces } from '../../schema/foundation.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { withWorkspaceReadTransaction } from '../../tenant-access/transactions.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';

interface Input {
  workspaceId: string;
  signal?: AbortSignal | undefined;
}
type PolicyState =
  'active' | 'suspended' | 'not_yet_effective' | 'expired' | 'unavailable';

export type WorkspaceUsageCapacityInput = Readonly<Input>;
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
export async function readWorkspaceUsageCapacity(
  pool: Pool,
  input: WorkspaceUsageCapacityInput,
): Promise<WorkspaceUsageCapacityRecord> {
  return withWorkspaceReadTransaction(
    pool,
    input.workspaceId,
    async (transaction) => {
      const [row] = await capacityQuery(transaction);
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
    },
    {
      statementTimeoutMillis: 2_000,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );
}

function capacityQuery({ db, workspaceId }: WorkspaceTransaction) {
  return db
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
      artifact_count_limit: sql<number>`coalesce(${workspaceArtifactCapacity.artifactCountLimit},${sql.raw(String(DEFAULT_ARTIFACT_COUNT_LIMIT))})`,
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
    .where(
      and(
        eq(workspaces.id, workspaceId),
        inArray(workspaces.status, BROWSABLE_WORKSPACE_STATUSES),
      ),
    );
}
