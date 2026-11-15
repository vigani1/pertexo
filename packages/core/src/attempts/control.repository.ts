import { sql } from 'drizzle-orm';
import { workflowRuns } from '@pertexo/database/schema';

/** Cancellation takes precedence over a deadline, including during heartbeats. */
export const runAbortReason = sql<
  'canceled' | 'timed_out' | null
>`case when ${workflowRuns.cancelRequestedAt} is not null then 'canceled' when ${workflowRuns.deadlineAt} is not null and ${workflowRuns.deadlineAt}<=clock_timestamp() then 'timed_out' else null end`;
