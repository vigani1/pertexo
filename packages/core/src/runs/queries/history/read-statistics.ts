import type { Pool } from 'pg';
import { withRetainedRunRead } from '../../access.js';
import { readWorkflowRunStatisticsRows } from './statistics.repository.js';
const WORKFLOW_RUN_STATISTICS_STATEMENT_TIMEOUT_MILLIS = 2_000;
export function readWorkflowRunStatistics(
  pool: Pool,
  input: Parameters<typeof readWorkflowRunStatisticsRows>[1],
) {
  return withRetainedRunRead(
    pool,
    input,
    (transaction) => readWorkflowRunStatisticsRows(transaction, input),
    WORKFLOW_RUN_STATISTICS_STATEMENT_TIMEOUT_MILLIS,
  );
}
