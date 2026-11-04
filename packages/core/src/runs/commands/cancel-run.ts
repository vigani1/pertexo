import { appendAuditFacts } from '../../governance/audit/facts.js';
import {
  appendLockedRunEvents,
  RUN_EVENT_TYPE,
} from '../queries/history/events.repository.js';
import { lockWorkspaceRunAdmission } from '../../shared/workspace-fence.repository.js';
import { workflowRuns } from '@pertexo/database/schema';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { requestWorkflowRunCancellation } from './request-cancellation.js';
import { WorkflowRunNotFoundError } from '../workflow-run.errors.js';
import {
  enqueueAdvance,
  enqueueAdvances,
} from '../wakeups/advance.repository.js';
import { ACTIVE_RUN_STATUSES } from '../statuses.js';
import {
  insertWorkflowRunAudit,
  readWorkflowRunRecord,
} from './workflow-run-records.repository.js';
import type { WorkflowRunRecord } from './workflow-run-records.repository.js';
import type { CancelWorkflowRunInput } from './run-commands.types.js';

/**
 * Requests cancellation of every run in the workspace that has not finished
 * and is not already being canceled, as one actor with one reason.
 */
export async function requestActiveRunCancellations(
  transaction: WorkspaceTransaction,
  input: Readonly<{ actorId: string; reason: string }>,
): Promise<number> {
  await lockWorkspaceRunAdmission(transaction.db, transaction.workspaceId);
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
  // Bound SQL parameters and temporary rows without splitting the lifecycle commit.
  for (let offset = 0; offset < active.length; offset += 500) {
    const ids = active.slice(offset, offset + 500).map((row) => row.id);
    await transaction.db
      .update(workflowRuns)
      .set({
        cancelRequestedAt: sql`clock_timestamp()`,
        cancelRequestedBy: input.actorId,
        cancelReason: input.reason,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(workflowRuns.workspaceId, transaction.workspaceId),
          inArray(workflowRuns.id, ids),
        ),
      );
    await appendLockedRunEvents(transaction, ids, {
      type: RUN_EVENT_TYPE.cancelRequested,
      payload: { actor: input.actorId, reason: input.reason },
    });
    await enqueueAdvances(transaction.db, {
      workspaceId: transaction.workspaceId,
      runIds: ids,
    });
    await appendAuditFacts(
      transaction,
      ids.map((runId) => ({
        workspaceId: transaction.workspaceId,
        actorId: input.actorId,
        action: 'workflow.run.cancel_requested',
        targetType: 'workflow_run',
        targetId: runId,
        metadata: { reasonProvided: true },
      })),
    );
  }
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
