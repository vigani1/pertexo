import {
  pendingRunTasks,
  workflows,
  workflowConcurrencyPolicies,
  workflowRuns,
  workflowRunActiveAdmissions,
  workspaceExecutionEntitlementVersions,
} from '@pertexo/database/schema';
import { workflowRunSelection } from './records.queries.js';
import { and, eq, exists, isNull, lt, notExists, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { WorkspaceTransaction } from '@pertexo/database/primitives';

/** Reads the run and its admission facts in one statement and snapshot. */
export function workflowRunReadQuery(
  transaction: WorkspaceTransaction,
  { includeWorkflowName }: Readonly<{ includeWorkflowName: boolean }>,
) {
  const { db, workspaceId } = transaction;
  const earlier = alias(workflowRuns, 'admission_earlier_run');
  const earlierReservation = alias(
    workflowRunActiveAdmissions,
    'admission_earlier_reservation',
  );
  const workspaceActive = sql<number>`(select active_runs from app.workflow_run_slot_counts(${workspaceId}::uuid))`;
  const workspaceReserved = sql<number>`(select reserved_active_slots from app.workflow_run_slot_counts(${workspaceId}::uuid))`;
  const workflowActive = sql<number>`(select active_runs from app.workflow_run_slot_counts(${workspaceId}::uuid,${workflowRuns.workflowId}))`;
  const workflowReserved = sql<number>`(select reserved_active_slots from app.workflow_run_slot_counts(${workspaceId}::uuid,${workflowRuns.workflowId}))`;
  const earlierExempt = db
    .select({ id: earlierReservation.workflowRunId })
    .from(earlierReservation)
    .where(
      and(
        eq(earlierReservation.workspaceId, workspaceId),
        eq(earlierReservation.workflowRunId, earlier.id),
        eq(earlierReservation.workflowConcurrencyOrderExempt, true),
      ),
    );
  const earlierQueued = db
    .select({ id: earlier.id })
    .from(earlier)
    .where(
      and(
        eq(earlier.workspaceId, workspaceId),
        eq(earlier.workflowId, workflowRuns.workflowId),
        eq(earlier.status, 'queued'),
        lt(earlier.admissionTicket, workflowRuns.admissionTicket),
        isNull(earlier.cancelRequestedAt),
        or(
          isNull(earlier.deadlineAt),
          sql`${earlier.deadlineAt} > statement_timestamp()`,
        ),
        notExists(earlierExempt),
      ),
    );
  return db
    .select({
      run: {
        ...workflowRunSelection,
        has_human_tasks: sql<boolean>`${exists(
          db
            .select({ one: sql`1` })
            .from(pendingRunTasks)
            .where(
              and(
                eq(pendingRunTasks.workspaceId, workflowRuns.workspaceId),
                eq(pendingRunTasks.runId, workflowRuns.id),
              ),
            ),
        )}`,
        human_wait_started_at: workflowRuns.humanWaitStartedAt,
        remaining_execution_ms: workflowRuns.remainingExecutionMs,
        absolute_deadline_at: workflowRuns.absoluteDeadlineAt,
        replay_source_run_id: workflowRuns.replaySourceRunId,
        recovery_target_node_run_id: workflowRuns.recoveryTargetNodeRunId,
        recovery_target_node_id: workflowRuns.recoveryTargetNodeId,
        recovery_reused_count: workflowRuns.recoveryReusedCount,
        handled_failure_count: workflowRuns.handledFailureCount,
        recovery_effect_risk: workflowRuns.recoveryEffectRisk,
        recovery_effects_acknowledged: workflowRuns.recoveryEffectsAcknowledged,
      },
      workflowName: includeWorkflowName
        ? workflows.name
        : sql<string | null>`null`,
      cursor: sql<string>`to_char(${workflowRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      asOf: sql<string>`to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      eligible: sql<boolean>`${workflowRuns.status} = 'queued' and ${workflowRuns.cancelRequestedAt} is null and (${workflowRuns.deadlineAt} is null or ${workflowRuns.deadlineAt} > statement_timestamp())`,
      reserved: sql<boolean>`${workflowRunActiveAdmissions.workflowRunId} is not null`,
      orderExempt: workflowRunActiveAdmissions.workflowConcurrencyOrderExempt,
      workspaceLimit: workspaceExecutionEntitlementVersions.activeRunLimit,
      workflowLimit: workflowConcurrencyPolicies.activeRunLimit,
      workspaceActive: workspaceActive.mapWith(Number),
      workspaceReserved: workspaceReserved.mapWith(Number),
      workflowActive: workflowActive.mapWith(Number),
      workflowReserved: workflowReserved.mapWith(Number),
      earlierQueued: exists(earlierQueued),
    })
    .from(workflowRuns)
    .leftJoin(
      workflows,
      and(
        eq(workflows.workspaceId, workflowRuns.workspaceId),
        eq(workflows.id, workflowRuns.workflowId),
      ),
    )
    .leftJoin(
      workflowRunActiveAdmissions,
      and(
        eq(workflowRunActiveAdmissions.workspaceId, workflowRuns.workspaceId),
        eq(workflowRunActiveAdmissions.workflowRunId, workflowRuns.id),
      ),
    )
    .leftJoin(
      workspaceExecutionEntitlementVersions,
      and(
        eq(
          workspaceExecutionEntitlementVersions.workspaceId,
          workflowRuns.workspaceId,
        ),
        eq(
          workspaceExecutionEntitlementVersions.version,
          workflowRuns.executionEntitlementVersion,
        ),
      ),
    )
    .leftJoin(
      workflowConcurrencyPolicies,
      and(
        eq(workflowConcurrencyPolicies.workspaceId, workflowRuns.workspaceId),
        eq(workflowConcurrencyPolicies.workflowId, workflowRuns.workflowId),
      ),
    );
}

type AdmissionProjection = Awaited<
  ReturnType<typeof workflowRunReadQuery>
>[number];

/** Explains only the queued run's present blockers, in the public reason order. */
export function runAdmissionBlockers(row: AdmissionProjection) {
  if (!row.eligible) return null;
  const reasons: (
    'workspace_capacity' | 'workflow_capacity' | 'workflow_order'
  )[] = [];
  const workspaceCapacityReached =
    !row.reserved &&
    row.workspaceLimit !== null &&
    row.workspaceActive + row.workspaceReserved >= row.workspaceLimit;
  if (workspaceCapacityReached) reasons.push('workspace_capacity');
  if (row.workflowLimit !== null) {
    if (
      !row.reserved &&
      row.workflowActive + row.workflowReserved >= row.workflowLimit
    )
      reasons.push('workflow_capacity');
    if (!row.orderExempt && row.earlierQueued) reasons.push('workflow_order');
  }
  return { asOf: row.asOf, reasons };
}
