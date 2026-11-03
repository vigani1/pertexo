import { lockWorkspaceRunAdmission } from '../admission-locks.repository.js';
import { workflowRuns } from '@pertexo/database/schema';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { requestWorkflowRunCancellation } from './request-cancellation.js';
import { WorkflowRunNotFoundError } from '../errors.js';
import { enqueueAdvance } from '../wakeups/advance.repository.js';
import { ACTIVE_RUN_STATUSES } from '../statuses.js';
import {
  insertWorkflowRunAudit,
  readWorkflowRunRecord,
} from './records.repository.js';
import type { WorkflowRunRecord } from './records.repository.js';
import type { CancelWorkflowRunInput } from './run-commands.types.js';

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
        inArray(workflowRuns.status, ACTIVE_RUN_STATUSES),
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
  input: CancelWorkflowRunInput,
): Promise<
  Readonly<{
    run: WorkflowRunRecord;
    alreadyRequested: boolean;
    eventSequence: number | null;
  }>
> {
  // The cancellation audit references workspace. Lifecycle/purge owns that
  // row before runs, so take its shared lock before the exclusive run lock.
  await lockWorkspaceRunAdmission(transaction.db, transaction.workspaceId);
  const cancellation = await requestWorkflowRunCancellation(transaction, {
    actor: input.actorId,
    runId: input.runId,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
  if (!cancellation.duplicate) {
    await enqueueAdvance(transaction.db, {
      workspaceId: transaction.workspaceId,
      runId: input.runId,
      traceparent: input.traceparent,
    });
    await insertWorkflowRunAudit(transaction, {
      action: 'workflow.run.cancel_requested',
      actorId: input.actorId,
      runId: input.runId,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      metadata: { reasonProvided: input.reason !== undefined },
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
