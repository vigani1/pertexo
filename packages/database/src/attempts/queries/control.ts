import { sql } from 'drizzle-orm';
import { workflowRuns } from '../../schema/runs/execution.js';
import type { NodeAttemptControl } from '../contract.js';

/** Cancellation takes precedence over a deadline, including during heartbeats. */
export const runAbortReason = sql<
  'canceled' | 'timed_out' | null
>`case when ${workflowRuns.cancelRequestedAt} is not null then 'canceled' when ${workflowRuns.deadlineAt} is not null and ${workflowRuns.deadlineAt}<=clock_timestamp() then 'timed_out' else null end`;

export function attemptControl(
  abortReason: 'canceled' | 'timed_out' | null,
): NodeAttemptControl {
  return abortReason === null
    ? { kind: 'none' }
    : { kind: 'abort', reason: abortReason };
}
