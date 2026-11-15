import { entitlementPolicyState } from '../entitlement-effect.repository.js';
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
import type { PoolClient } from 'pg';

export type PolicyState =
  'active' | 'suspended' | 'not_yet_effective' | 'expired' | 'unavailable';

export function capacityQuery(client: PoolClient, workspaceId: string) {
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
