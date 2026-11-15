import type { RunFailureCode } from '@pertexo/workflow-model';
import type {
  AuditMetadata,
  WorkspaceTransaction,
} from '@pertexo/database/primitives';
import { appendAuditFact } from '../../governance/audit/facts.js';
import {
  workflowRunRecords,
  type WorkflowRunRow,
} from '../queries/workflow-runs.repository.js';
import type { RunValues } from '@pertexo/node-sdk';
import { runValuesInTransaction } from '../values/rows.repository.js';
import { retainedTestRunSql } from '../../shared/run-retention.repository.js';
import type { WorkflowRecoverySummary } from '../recovery/workflow-recovery.types.js';
import { workflowRuns } from '@pertexo/database/schema';
import {
  workflowRunReadQuery,
  runAdmissionBlockers,
} from '../queries/admission.repository.js';
import { and, eq } from 'drizzle-orm';

export type WorkflowRunRecord = Readonly<WorkflowRunRow>;

export type WorkflowRunReadRecord = WorkflowRunRecord &
  Readonly<{
    failureReasonCode: RunFailureCode | null;
    hasHumanTasks?: boolean;
    runValues?: RunValues;
    /** The next step passed its time and nothing has acted on it yet. */
    stalled?: Readonly<{ since: string }>;
    humanWait?: Readonly<{
      since: string;
      remainingExecutionMs: number | null;
      absoluteDeadlineAt: string | null;
    }>;
    workflowName?: string | null;
    replaySourceRunId: string | null;
    recovery?: WorkflowRecoverySummary;
    handledFailureCount?: number;
    admissionBlockers?: Readonly<{
      asOf: string;
      reasons: readonly (
        'workspace_capacity' | 'workflow_capacity' | 'workflow_order'
      )[];
    }>;
  }>;

export async function readWorkflowRunRecord(
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<WorkflowRunRecord | undefined> {
  const [row] = await workflowRunRecords(transaction.db)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, runId),
      ),
    )
    .limit(1);
  return row === undefined ? undefined : Object.freeze(row);
}

export async function readWorkflowRunReadRecord(
  transaction: WorkspaceTransaction,
  runId: string,
  { includeWorkflowName }: Readonly<{ includeWorkflowName: boolean }>,
): Promise<WorkflowRunReadRecord | undefined> {
  const [row] = await workflowRunReadQuery(transaction, {
    includeWorkflowName,
  })
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, runId),
        retainedTestRunSql('workflow_runs'),
      ),
    )
    .limit(1);
  if (row === undefined) return undefined;
  return Object.freeze({
    ...toWorkflowRunReadRecord({
      ...row.run,
      workflow_name: row.workflowName,
      admission_blockers: runAdmissionBlockers(row),
    }),
    runValues: await runValuesInTransaction(transaction, runId),
  });
}

export async function insertWorkflowRunAudit(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    action: string;
    actorId: string;
    runId: string;
    requestId?: string;
    traceId?: string;
    metadata: AuditMetadata;
  }>,
): Promise<void> {
  await appendAuditFact(transaction, {
    workspaceId: transaction.workspaceId,
    actorId: input.actorId,
    action: input.action,
    targetType: 'workflow_run',
    targetId: input.runId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    metadata: input.metadata,
  });
}

type ReadRow = Awaited<
  ReturnType<typeof workflowRunReadQuery>
>[number]['run'] & {
  workflow_name: string | null;
  admission_blockers: ReturnType<typeof runAdmissionBlockers>;
};
export function toWorkflowRunReadRecord(row: ReadRow): WorkflowRunReadRecord {
  const {
    has_human_tasks: hasHumanTasks,
    human_wait_started_at: humanWaitStartedAt,
    remaining_execution_ms: remainingExecutionMs,
    absolute_deadline_at: absoluteDeadlineAt,
    handled_failure_count: handledFailureCount,
    workflow_name: workflowName,
    replay_source_run_id: replaySourceRunId,
    admission_blockers: admissionBlockers,
    recovery_target_node_run_id: targetNodeRunId,
    recovery_target_node_id: targetNodeId,
    recovery_reused_count: reusedCount,
    recovery_effect_risk: effectRisk,
    recovery_effects_acknowledged: effectsAcknowledged,
    ...runRow
  } = row;
  const incompleteRecovery =
    targetNodeRunId === null ||
    targetNodeId === null ||
    reusedCount === null ||
    effectRisk === null ||
    effectsAcknowledged === null;
  return Object.freeze({
    ...runRow,
    workflowName,
    ...(hasHumanTasks ? { hasHumanTasks: true } : {}),
    ...(humanWaitStartedAt === null || row.status !== 'waiting'
      ? {}
      : {
          humanWait: {
            since: humanWaitStartedAt.toISOString(),
            remainingExecutionMs,
            absoluteDeadlineAt: absoluteDeadlineAt?.toISOString() ?? null,
          },
        }),
    replaySourceRunId,
    ...(handledFailureCount === 0 ? {} : { handledFailureCount }),
    ...(incompleteRecovery
      ? {}
      : {
          recovery: {
            targetNodeRunId,
            targetNodeId,
            reusedCount,
            effectRisk,
            effectsAcknowledged,
          },
        }),
    ...(admissionBlockers == null ? {} : { admissionBlockers }),
  });
}
