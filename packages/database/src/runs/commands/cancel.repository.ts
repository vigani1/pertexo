import { workflowRuns } from '../../schema/runs/execution.js';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { ExecutionStateConflictError } from '../state-errors.js';
import {
  appendLockedRunEvent,
  RUN_EVENT_TYPE,
} from '../queries/history/events.repository.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';

const actorSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u);
const cancellationSchema = z
  .object({
    actor: actorSchema,
    reason: z.string().min(1).max(512).nullable().optional(),
    runId: z.uuid(),
  })
  .strict();
const terminalRunStatuses = new Set([
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);

export async function requestWorkflowRunCancellation(
  transaction: WorkspaceTransaction,
  input: Readonly<z.input<typeof cancellationSchema>>,
): Promise<
  Readonly<{
    duplicate: boolean;
    eventSequence: number | null;
    requestedAt: Date;
  }>
> {
  const parsed = cancellationSchema.parse(input);
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
        eq(workflowRuns.id, parsed.runId),
      ),
    )
    .for('update');
  if (row === undefined)
    throw new ExecutionStateConflictError('execution.run_not_found');
  if (terminalRunStatuses.has(row.status))
    throw new ExecutionStateConflictError('execution.run_terminal');
  if (row.cancel_requested_at !== null) {
    if (
      row.cancel_requested_by !== parsed.actor ||
      row.cancel_reason !== (parsed.reason ?? null)
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
      cancelRequestedBy: parsed.actor,
      cancelReason: parsed.reason ?? null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, parsed.runId),
      ),
    )
    .returning({
      cancel_requested_at: sql<Date>`${workflowRuns.cancelRequestedAt}`.mapWith(
        workflowRuns.cancelRequestedAt,
      ),
    });
  const eventSequence = await appendLockedRunEvent(transaction, parsed.runId, {
    type: RUN_EVENT_TYPE.cancelRequested,
    payload: {
      actor: parsed.actor,
      ...(parsed.reason == null ? {} : { reason: parsed.reason }),
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
