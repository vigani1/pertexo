import type { Pool } from 'pg';
import { withResourceWorkflowRead } from '../../access.js';
import {
  readWorkflowStepHealthRows,
  readWorkflowStepRunsRows,
} from './steps.repository.js';

export function readWorkflowStepHealth(
  pool: Pool,
  input: Parameters<typeof readWorkflowStepHealthRows>[1],
) {
  return withResourceWorkflowRead(pool, input, (transaction) =>
    readWorkflowStepHealthRows(transaction, input),
  );
}
export function readWorkflowStepRuns(
  pool: Pool,
  input: Parameters<typeof readWorkflowStepRunsRows>[1],
) {
  return withResourceWorkflowRead(pool, input, (transaction) =>
    readWorkflowStepRunsRows(transaction, input),
  );
}
