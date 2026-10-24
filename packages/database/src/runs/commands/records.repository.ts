import type { RunValues } from '@pertexo/node-sdk';
import { runValuesInTransaction } from '../values/records.queries.js';
import { retainedTestRunSql } from '../data-policy.js';
import type { WorkflowRecoverySummary } from '../recovery/contract.js';
import { workflowRuns } from '../../schema/runs/execution.js';
import {
  workflowRunReadQuery,
  runAdmissionBlockers,
} from '../queries/admission.queries.js';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { generatePersistedId } from '../../platform/persisted-id.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import {
  acceptWorkflowRun,
  type AcceptWorkflowRunInput,
} from './acceptance.repository.js';
import { WorkflowRunNotFoundError } from '../errors.js';

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);
const triggerTypeSchema = z.enum([
  'test',
  'api',
  'manual',
  'replay',
  'schedule',
  'webhook',
  'workflow_call',
  'workflow_error',
  'form',
]);
const runRowSchema = z
  .object({
    id: z.uuid(),
    workspace_id: z.uuid(),
    workflow_id: z.uuid(),
    workflow_version_id: z.uuid(),
    status: runStatusSchema,
    trigger_type: triggerTypeSchema,
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
    started_at: z.coerce.date().nullable(),
    completed_at: z.coerce.date().nullable(),
    deadline_at: z.coerce.date().nullable(),
    cancel_requested_at: z.coerce.date().nullable(),
  })
  .strict();
const runReadRowSchema = runRowSchema.extend({
  has_human_tasks: z.boolean(),
  human_wait_started_at: z.coerce.date().nullable(),
  remaining_execution_ms: z.number().int().positive().nullable(),
  absolute_deadline_at: z.coerce.date().nullable(),
  handled_failure_count: z.number().int().min(0).max(200),
  admission_blockers: z
    .object({
      asOf: z.iso.datetime({ precision: 6 }),
      reasons: z.array(
        z.enum(['workspace_capacity', 'workflow_capacity', 'workflow_order']),
      ),
    })
    .strict()
    .nullable()
    .optional(),
  workflow_name: z.string().min(1).max(128).nullable(),
  replay_source_run_id: z.uuid().nullable(),
  recovery_target_node_run_id: z.uuid().nullable(),
  recovery_target_node_id: z.string().nullable(),
  recovery_reused_count: z.number().int().nonnegative().nullable(),
  recovery_effect_risk: z
    .enum(['ordinary', 'possible_effects', 'unknown_outcome'])
    .nullable(),
  recovery_effects_acknowledged: z.boolean().nullable(),
});

export type WorkflowRunRecord = Readonly<{
  id: string;
  workspaceId: string;
  workflowId: string;
  workflowVersionId: string;
  status: z.output<typeof runStatusSchema>;
  triggerType: z.output<typeof triggerTypeSchema>;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  deadlineAt: Date | null;
  cancelRequestedAt: Date | null;
}>;

export type WorkflowRunReadRecord = WorkflowRunRecord &
  Readonly<{
    hasHumanTasks?: boolean;
    runValues?: RunValues;
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
  const result = await transaction.db.execute(sql`
    select
      id,
      workspace_id,
      workflow_id,
      workflow_version_id,
      status,
      trigger_type,
      created_at,
      updated_at,
      started_at,
      completed_at,
      deadline_at,
      cancel_requested_at
    from app.workflow_runs
    where workspace_id = ${transaction.workspaceId} and id = ${runId}
    limit 1
  `);
  const row = result.rows[0];
  return row === undefined ? undefined : toWorkflowRunRecord(row);
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

export async function requireWorkflowRunRecord(
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<WorkflowRunRecord> {
  const run = await readWorkflowRunRecord(transaction, runId);
  if (run === undefined) throw new WorkflowRunNotFoundError();
  return run;
}

export async function acceptWorkflowRunWithAudit(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    acceptance: AcceptWorkflowRunInput;
    actorId: string;
    auditAction: string;
    auditMetadata: ReturnType<typeof sql>;
    requestId?: string;
    traceId?: string;
  }>,
): Promise<Readonly<{ run: WorkflowRunRecord; replayed: boolean }>> {
  const accepted = await acceptWorkflowRun(transaction, {
    ...input.acceptance,
    startedBy: input.actorId,
  });
  const run = await requireWorkflowRunRecord(transaction, accepted.runId);
  if (!accepted.duplicate) {
    await insertWorkflowRunAudit(transaction, {
      action: input.auditAction,
      actorId: input.actorId,
      runId: run.id,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      metadata: input.auditMetadata,
    });
  }
  return Object.freeze({ run, replayed: accepted.duplicate });
}

export async function insertWorkflowRunAudit(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    action: string;
    actorId: string;
    runId: string;
    requestId?: string;
    traceId?: string;
    metadata: ReturnType<typeof sql>;
  }>,
): Promise<void> {
  await transaction.db.execute(sql`
    insert into app.audit_events
      (id, workspace_id, actor_user_id, action, target_type, target_id,
       request_id, trace_id, metadata)
    values
      (${generatePersistedId()}, ${transaction.workspaceId}, ${input.actorId},
       ${input.action}, 'workflow_run', ${input.runId},
       ${input.requestId ?? null}, ${input.traceId ?? null}, ${input.metadata})
  `);
}

function toWorkflowRunRecord(value: unknown): WorkflowRunRecord {
  const row = runRowSchema.parse(value);
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    status: row.status,
    triggerType: row.trigger_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    deadlineAt: row.deadline_at,
    cancelRequestedAt: row.cancel_requested_at,
  });
}

export function toWorkflowRunReadRecord(value: unknown): WorkflowRunReadRecord {
  const row = runReadRowSchema.parse(value);
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
    ...toWorkflowRunRecord(runRow),
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
