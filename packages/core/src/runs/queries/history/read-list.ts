import type { Pool } from 'pg';
import { withRetainedRunRead } from '../../access.js';
import { readWorkflowRunListPageRows } from './list.repository.js';

export function readWorkflowRunListPage(
  pool: Pool,
  input: Parameters<typeof readWorkflowRunListPageRows>[1],
) {
  return withRetainedRunRead(pool, input, (transaction) =>
    readWorkflowRunListPageRows(transaction, input),
  );
}
