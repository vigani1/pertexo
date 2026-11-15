import {
  lockRunCancellation,
  markRunCancelRequested,
} from './cancellation.repository.js';
import { ExecutionStateConflictError } from '../../shared/run-records/execution-state.errors.js';
import { TERMINAL_RUN_STATUSES } from '../statuses.js';
import {
  appendLockedRunEvent,
  RUN_EVENT_TYPE,
} from '../../shared/run-records/run-events.repository.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

interface Cancellation {
  actor: string;
  runId: string;
  reason?: string | null | undefined;
}

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
  const row = await lockRunCancellation(transaction, input.runId);
  if (row === undefined)
    throw new ExecutionStateConflictError('execution.run_not_found');
  if (TERMINAL_RUN_STATUSES.has(row.status))
    throw new ExecutionStateConflictError('execution.run_terminal');
  if (row.cancelRequestedAt !== null) {
    if (
      row.cancelRequestedBy !== input.actor ||
      row.cancelReason !== (input.reason ?? null)
    )
      throw new ExecutionStateConflictError(
        'execution.cancel_request_conflict',
      );
    return Object.freeze({
      duplicate: true,
      eventSequence: null,
      requestedAt: row.cancelRequestedAt,
    });
  }

  const requestedAt = await markRunCancelRequested(transaction, input.runId, {
    actorId: input.actor,
    reason: input.reason ?? null,
  });
  const eventSequence = await appendLockedRunEvent(transaction, input.runId, {
    type: RUN_EVENT_TYPE.cancelRequested,
    payload: {
      actor: input.actor,
      ...(input.reason == null ? {} : { reason: input.reason }),
    },
  });
  if (requestedAt === undefined)
    throw new ExecutionStateConflictError('execution.cancel_update_lost');
  return Object.freeze({ duplicate: false, eventSequence, requestedAt });
}
