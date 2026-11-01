import { entitlementInEffect } from '../../runs/queries/entitlement-effect.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { WorkspaceCapacityLimit } from '@pertexo/contracts';
import {
  and,
  eq,
  isNull,
  notInArray,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import { union } from 'drizzle-orm/pg-core';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  workspaces,
  workspaceExecutionAdmissionCounters as counter,
  workflowRunActiveAdmissions as admission,
  workspaceExecutionEntitlements as pointer,
  workspaceExecutionEntitlementVersions as entitlement,
  workspaceArtifactCapacity as capacity,
  workflowRuns,
} from '@pertexo/database/schema';
export const CAPACITY_LIMIT_LABELS: Readonly<
  Record<WorkspaceCapacityLimit, string>
> = {
  active: 'Active runs',
  queue: 'Queued runs',
  artifact_bytes: 'File storage',
  artifact_count: 'File count',
};
function approaching(
  used: SQLWrapper,
  limit: SQLWrapper,
  available: SQL = sql`true`,
): SQL<boolean> {
  return sql`coalesce((${available}) and (${limit})>0 and (${used})::numeric*5>=(${limit})::numeric*4,false)`;
}
const effective = sql`${counter.workspaceId} is not null and ${entitlementInEffect(entitlement, sql`statement_timestamp()`)}`;
function metrics(active: SQL, queued: SQL) {
  return {
    active: approaching(active, entitlement.activeRunLimit, effective),
    queue: approaching(queued, entitlement.queuedRunLimit, effective),
    artifact_bytes: approaching(capacity.chargedBytes, capacity.byteLimit),
    artifact_count: approaching(
      capacity.chargedCount,
      capacity.artifactCountLimit,
    ),
  };
}
export const slotCounts = sql`app.workflow_run_slot_counts(${workspaces.id}) counts`;
export async function readCapacityWarning(
  client: PoolClient,
  workspaceId: string,
  key: WorkspaceCapacityLimit,
): Promise<boolean> {
  const [row] = await drizzle(client)
    .select(
      metrics(
        sql`counts.active_runs+counts.reserved_active_slots`,
        sql`counts.queued_runs`,
      ),
    )
    .from(workspaces)
    .innerJoin(slotCounts, sql`true`)
    .leftJoin(counter, eq(counter.workspaceId, workspaces.id))
    .leftJoin(pointer, eq(pointer.workspaceId, workspaces.id))
    .leftJoin(
      entitlement,
      and(
        eq(entitlement.workspaceId, pointer.workspaceId),
        eq(entitlement.version, pointer.currentVersion),
      ),
    )
    .leftJoin(capacity, eq(capacity.workspaceId, workspaces.id))
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.status, 'active')))
    .catch(rethrowQueryFailure);
  return row?.[key] ?? false;
}
/** Maintenance discovers candidates without installing a tenant context globally. */
export function capacityWarningCandidates(db: Pick<NodePgDatabase, 'select'>) {
  const reserved = db
    .select({ held: sql<number>`count(*)::integer`.as('held') })
    .from(admission)
    .innerJoin(
      workflowRuns,
      and(
        eq(workflowRuns.workspaceId, admission.workspaceId),
        eq(workflowRuns.id, admission.workflowRunId),
      ),
    )
    .where(
      and(
        eq(admission.workspaceId, workspaces.id),
        isNull(workflowRuns.humanWaitStartedAt),
        notInArray(workflowRuns.status, ['running', 'waiting']),
      ),
    )
    .as('reserved');
  const conditions = metrics(
    sql`${counter.activeRuns}+${reserved.held}`,
    sql`${counter.queuedRuns}`,
  );
  function candidates(key: WorkspaceCapacityLimit) {
    return db
      .select({
        workspace_id: workspaces.id,
        capacity_limit: sql<WorkspaceCapacityLimit>`${key}::varchar`.as(
          'capacity_limit',
        ),
      })
      .from(workspaces)
      .leftJoin(counter, eq(counter.workspaceId, workspaces.id))
      .leftJoin(pointer, eq(pointer.workspaceId, workspaces.id))
      .leftJoin(
        entitlement,
        and(
          eq(entitlement.workspaceId, pointer.workspaceId),
          eq(entitlement.version, pointer.currentVersion),
        ),
      )
      .leftJoin(capacity, eq(capacity.workspaceId, workspaces.id))
      .leftJoinLateral(reserved, sql`true`)
      .where(and(eq(workspaces.status, 'active'), conditions[key]));
  }
  return union(
    candidates('active'),
    candidates('queue'),
    candidates('artifact_bytes'),
    candidates('artifact_count'),
  );
}
