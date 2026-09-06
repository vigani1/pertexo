import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { generatePersistedId } from '../platform/persisted-id.js';
import type { WorkspaceTransaction } from '../tenant-access/workspace.js';
import {
  acceptWorkflowRun,
  type AcceptWorkflowRunInput,
} from './execution-acceptance.js';
import { WorkflowRunNotFoundError } from './workflow-run-errors.js';

const runStatusSchema = z.enum([
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
  'api',
  'manual',
  'replay',
  'schedule',
  'webhook',
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
  const accepted = await acceptWorkflowRun(transaction, input.acceptance);
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
