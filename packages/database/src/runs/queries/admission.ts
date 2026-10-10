import {
  and,
  count,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { workflows } from '../../schema/authoring/workflows.js';
import { workflowConcurrencyPolicies } from '../../schema/authoring/concurrency.js';
import { workflowRuns } from '../../schema/runs/execution.js';
import { workflowRunActiveAdmissions } from '../../schema/runs/admission.js';
import { workspaceExecutionEntitlementVersions } from '../../schema/runs/entitlements.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';

/** Reads the run and its admission facts in one statement and snapshot. */
export function workflowRunReadQuery(
  transaction: WorkspaceTransaction,
  includeWorkflowName: boolean,
) {
  const { db, workspaceId } = transaction;
  const active = alias(workflowRuns, 'admission_active_run');
  const reserved = alias(
    workflowRunActiveAdmissions,
    'admission_reserved_slot',
  );
  const reservedRun = alias(workflowRuns, 'admission_reserved_run');
  const earlier = alias(workflowRuns, 'admission_earlier_run');
  const earlierReservation = alias(
    workflowRunActiveAdmissions,
    'admission_earlier_reservation',
  );
  const workspaceActive = db
    .select({ value: count() })
    .from(active)
    .where(
      and(
        eq(active.workspaceId, workspaceId),
        inArray(active.status, ['running', 'waiting']),
      ),
    );
  const workspaceReserved = db
    .select({ value: count() })
    .from(reserved)
    .where(eq(reserved.workspaceId, workspaceId));
  const workflowActive = db
    .select({ value: count() })
    .from(active)
    .where(
      and(
        eq(active.workspaceId, workspaceId),
        eq(active.workflowId, workflowRuns.workflowId),
        inArray(active.status, ['running', 'waiting']),
      ),
    );
  const workflowReserved = db
    .select({ value: count() })
    .from(reserved)
    .innerJoin(
      reservedRun,
      and(
        eq(reservedRun.workspaceId, reserved.workspaceId),
        eq(reservedRun.id, reserved.workflowRunId),
      ),
    )
    .where(
      and(
        eq(reserved.workspaceId, workspaceId),
        eq(reservedRun.workflowId, workflowRuns.workflowId),
      ),
    );
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
        id: workflowRuns.id,
        workspace_id: workflowRuns.workspaceId,
        workflow_id: workflowRuns.workflowId,
        workflow_version_id: workflowRuns.workflowVersionId,
        status: workflowRuns.status,
        trigger_type: workflowRuns.triggerType,
        created_at: workflowRuns.createdAt,
        updated_at: workflowRuns.updatedAt,
        started_at: workflowRuns.startedAt,
        completed_at: workflowRuns.completedAt,
        deadline_at: workflowRuns.deadlineAt,
        cancel_requested_at: workflowRuns.cancelRequestedAt,
        replay_source_run_id: workflowRuns.replaySourceRunId,
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
      workspaceActive: sql<number>`(${workspaceActive})`.mapWith(Number),
      workspaceReserved: sql<number>`(${workspaceReserved})`.mapWith(Number),
      workflowActive: sql<number>`(${workflowActive})`.mapWith(Number),
      workflowReserved: sql<number>`(${workflowReserved})`.mapWith(Number),
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
  if (
    !row.reserved &&
    row.workspaceLimit !== null &&
    row.workspaceActive + row.workspaceReserved >= row.workspaceLimit
  )
    reasons.push('workspace_capacity');
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
