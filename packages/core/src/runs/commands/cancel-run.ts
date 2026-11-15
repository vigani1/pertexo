import { appendAuditFacts } from '../../governance/audit/facts.js';
import {
  appendLockedRunEvents,
  RUN_EVENT_TYPE,
} from '../../shared/run-events.repository.js';
import { lockWorkspaceRunAdmission } from '../../shared/workspace-fence.repository.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { requestWorkflowRunCancellation } from './request-cancellation.js';
import { WorkflowRunNotFoundError } from '../workflow-run.errors.js';
import {
  enqueueAdvance,
  enqueueAdvances,
} from '../../outbox/run-advance.repository.js';
import {
  lockUncanceledActiveRuns,
  markRunsCancelRequested,
} from './cancellation.repository.js';
import {
  insertWorkflowRunAudit,
  readWorkflowRunRecord,
} from './workflow-run-records.repository.js';
import type { WorkflowRunRecord } from './workflow-run-records.repository.js';
import type { CancelWorkflowRunInput } from './run-commands.types.js';

/** Runs one cancel-all statement updates, bounding its parameters. */
const CANCELLATION_BATCH_SIZE = 500;

/**
 * Requests cancellation of every run in the workspace that has not finished
 * and is not already being canceled, as one actor with one reason.
 */
export async function requestActiveRunCancellations(
  transaction: WorkspaceTransaction,
  input: Readonly<{ actorId: string; reason: string }>,
): Promise<number> {
  await lockWorkspaceRunAdmission(transaction.db, transaction.workspaceId);
  const active = await lockUncanceledActiveRuns(transaction);
  // Bound SQL parameters and temporary rows without splitting the lifecycle commit.
  for (
    let offset = 0;
    offset < active.length;
    offset += CANCELLATION_BATCH_SIZE
  ) {
    const ids = active.slice(offset, offset + CANCELLATION_BATCH_SIZE);
    await markRunsCancelRequested(transaction, ids, input);
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
