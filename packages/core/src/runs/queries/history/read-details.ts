import type { Pool } from 'pg';
import { withResourceRunRead } from '../../access.js';
import {
  readWorkflowRunInputRows,
  readWorkflowNodeRunInputRows,
  readWorkflowNodeRunOutputRows,
  readWorkflowRunVariablesRows,
  readWorkflowNodeRunDiagnosticsRows,
} from './details.repository.js';

export function readWorkflowRunInput(
  pool: Pool,
  input: Parameters<typeof readWorkflowRunInputRows>[1],
) {
  return withResourceRunRead(pool, input, (transaction) =>
    readWorkflowRunInputRows(transaction, input),
  );
}
export function readWorkflowNodeRunInput(
  pool: Pool,
  input: Parameters<typeof readWorkflowNodeRunInputRows>[1],
) {
  return withResourceRunRead(pool, input, (transaction) =>
    readWorkflowNodeRunInputRows(transaction, input),
  );
}
export function readWorkflowNodeRunOutput(
  pool: Pool,
  input: Parameters<typeof readWorkflowNodeRunOutputRows>[1],
) {
  return withResourceRunRead(pool, input, (transaction) =>
    readWorkflowNodeRunOutputRows(transaction, input),
  );
}
export function readWorkflowRunVariables(
  pool: Pool,
  input: Parameters<typeof readWorkflowRunVariablesRows>[1],
) {
  return withResourceRunRead(pool, input, (transaction) =>
    readWorkflowRunVariablesRows(transaction, input),
  );
}
export function readWorkflowNodeRunDiagnostics(
  pool: Pool,
  input: Parameters<typeof readWorkflowNodeRunDiagnosticsRows>[1],
) {
  return withResourceRunRead(pool, input, (transaction) =>
    readWorkflowNodeRunDiagnosticsRows(transaction, input),
  );
}
