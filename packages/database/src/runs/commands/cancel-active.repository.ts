import { workflowRuns } from '../../schema/runs/execution.js';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../../outbox/events.repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { requestWorkflowRunCancellation } from './cancel.repository.js';
import { WorkflowRunNotFoundError } from '../errors.js';
import {
  insertWorkflowRunAudit,
  readWorkflowRunRecord,
} from './records.repository.js';
import type { WorkflowRunRecord } from './records.repository.js';
import type { CancelInput } from './input.js';

/**
 * Requests cancellation of every run in the workspace that has not finished
 * and is not already being canceled, as one actor with one reason.
 */
export async function requestActiveRunCancellations(
  transaction: WorkspaceTransaction,
  input: Readonly<{ actorId: string; reason: string }>,
): Promise<number> {
  const active = await transaction.db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        inArray(workflowRuns.status, ['queued', 'running', 'waiting']),
        isNull(workflowRuns.cancelRequestedAt),
      ),
    )
    .orderBy(asc(workflowRuns.id))
    .for('update');
  for (const { id } of active)
    await cancelInTransaction(transaction, {
      actorId: input.actorId,
      workspaceId: transaction.workspaceId,
      runId: id,
      reason: input.reason,
    });
  return active.length;
}

export async function cancelInTransaction(
  transaction: WorkspaceTransaction,
  input: CancelInput,
): Promise<
  Readonly<{
    run: WorkflowRunRecord;
    alreadyRequested: boolean;
    eventSequence: number | null;
  }>
> {
  // The cancellation audit references workspace. Lifecycle/purge owns that
  // row before runs, so take its shared lock before the exclusive run lock.
  await transaction.db.execute(
    sql`select app.lock_workspace_run_admission(${transaction.workspaceId})`,
  );
  const cancellation = await requestWorkflowRunCancellation(transaction, {
    actor: input.actorId,
    runId: input.runId,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
  if (!cancellation.duplicate) {
    const outboxEventId = generatePersistedId();
    const payload = {
      workspaceId: transaction.workspaceId,
      runId: input.runId,
      outboxEventId,
      ...(input.traceparent === undefined
        ? {}
        : { traceparent: input.traceparent }),
    } as const;
    await insertOutboxEvent(transaction, {
      id: outboxEventId,
      jobName: 'advance-workflow-run',
      aggregateType: 'workflow-run',
      aggregateId: input.runId,
      payload,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
    });
    await insertWorkflowRunAudit(transaction, {
      action: 'workflow.run.cancel_requested',
      actorId: input.actorId,
      runId: input.runId,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      metadata: sql`jsonb_build_object('reasonProvided', ${input.reason !== undefined}::boolean)`,
    });
  }
  const run = await readWorkflowRunRecord(transaction, input.runId);
  if (run === undefined) throw new WorkflowRunNotFoundError();
  return Object.freeze({
    run,
    alreadyRequested: cancellation.duplicate,
    eventSequence: cancellation.eventSequence,
  });
}
