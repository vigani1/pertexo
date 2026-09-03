import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { ExecutionStateConflictError } from './execution-state.js';
import { appendLockedRunEvent, RUN_EVENT_TYPE } from './run-events.js';
import type { WorkspaceTransaction } from './workspace.js';

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
  const result = await transaction.db.execute<{
    cancel_reason: string | null;
    cancel_requested_at: Date | null;
    cancel_requested_by: string | null;
    status: string;
  }>(sql`
    select status, cancel_requested_at, cancel_requested_by, cancel_reason
    from app.workflow_runs
    where workspace_id = ${transaction.workspaceId} and id = ${parsed.runId}
    for update
  `);
  const row = result.rows[0];
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
      requestedAt: z.coerce.date().parse(row.cancel_requested_at),
    });
  }

  const updated = await transaction.db.execute<{
    cancel_requested_at: Date;
  }>(sql`
    update app.workflow_runs
    set cancel_requested_at = clock_timestamp(), cancel_requested_by = ${parsed.actor},
        cancel_reason = ${parsed.reason ?? null}, updated_at = clock_timestamp()
    where workspace_id = ${transaction.workspaceId} and id = ${parsed.runId}
    returning cancel_requested_at
  `);
  const eventSequence = await appendLockedRunEvent(transaction, parsed.runId, {
    type: RUN_EVENT_TYPE.cancelRequested,
    payload: {
      actor: parsed.actor,
      ...(parsed.reason == null ? {} : { reason: parsed.reason }),
    },
  });
  const cancellation = updated.rows[0];
  if (cancellation === undefined)
    throw new ExecutionStateConflictError('execution.cancel_update_lost');
  return Object.freeze({
    duplicate: false,
    eventSequence,
    requestedAt: new Date(cancellation.cancel_requested_at),
  });
}
