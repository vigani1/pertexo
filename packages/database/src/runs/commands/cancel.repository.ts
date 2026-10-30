import { workflowRuns } from '../../schema/runs/execution.js';
import { and, eq, sql } from 'drizzle-orm';
import { ExecutionStateConflictError } from '../state-errors.js';
import {
  appendLockedRunEvent,
  RUN_EVENT_TYPE,
} from '../queries/history/events.repository.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';

interface Cancellation {
  actor: string;
  runId: string;
  reason?: string | null | undefined;
}
const terminalRunStatuses = new Set([
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);

export async function requestWorkflowRunCancellation(
  transaction: WorkspaceTransaction,
  input: Readonly<Cancellation>,
): Promise<
  Readonly<{
    duplicate: boolean;
    eventSequence: number | null;
    requestedAt: Date;
  }>
> {
  const [row] = await transaction.db
    .select({
      cancel_reason: workflowRuns.cancelReason,
      cancel_requested_at: workflowRuns.cancelRequestedAt,
      cancel_requested_by: workflowRuns.cancelRequestedBy,
      status: workflowRuns.status,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, input.runId),
      ),
    )
    .for('update');
  if (row === undefined)
    throw new ExecutionStateConflictError('execution.run_not_found');
  if (terminalRunStatuses.has(row.status))
    throw new ExecutionStateConflictError('execution.run_terminal');
  if (row.cancel_requested_at !== null) {
    if (
      row.cancel_requested_by !== input.actor ||
      row.cancel_reason !== (input.reason ?? null)
    )
      throw new ExecutionStateConflictError(
        'execution.cancel_request_conflict',
      );
    return Object.freeze({
      duplicate: true,
      eventSequence: null,
      requestedAt: row.cancel_requested_at,
    });
  }

  // This write always sets the returned timestamp; the schema supplies its Date decoder.
  const updated = await transaction.db
    .update(workflowRuns)
    .set({
      cancelRequestedAt: sql`clock_timestamp()`,
      cancelRequestedBy: input.actor,
      cancelReason: input.reason ?? null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, input.runId),
      ),
    )
    .returning({
      cancel_requested_at: sql<Date>`${workflowRuns.cancelRequestedAt}`.mapWith(
        workflowRuns.cancelRequestedAt,
      ),
    });
  const eventSequence = await appendLockedRunEvent(transaction, input.runId, {
    type: RUN_EVENT_TYPE.cancelRequested,
    payload: {
      actor: input.actor,
      ...(input.reason == null ? {} : { reason: input.reason }),
    },
  });
  const cancellation = updated[0];
  if (cancellation === undefined)
    throw new ExecutionStateConflictError('execution.cancel_update_lost');
  return Object.freeze({
    duplicate: false,
    eventSequence,
    requestedAt: new Date(cancellation.cancel_requested_at),
  });
}
