import type { WorkflowCallRefusalCode } from './contract.js';

/** A definite refusal rolls candidate acceptance back, then settles the intent. */
export class WorkflowCallRefusedError extends Error {
  override readonly name = 'WorkflowCallRefusedError';
  constructor(readonly code: WorkflowCallRefusalCode) {
    super(code);
  }
}
