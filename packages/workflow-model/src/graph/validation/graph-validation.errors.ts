import type { GraphValidationIssue } from './graph-validation.js';

export class InvalidWorkflowGraphError extends TypeError {
  public constructor(readonly issues: readonly GraphValidationIssue[]) {
    super('workflow graph failed semantic validation');
    this.name = 'InvalidWorkflowGraphError';
  }
}
export type WorkflowGraphContractIssueCode =
  'structured_depth' | 'json_value_depth' | 'invalid_json' | 'graph_limit';
export class WorkflowGraphContractError extends TypeError {
  public constructor(
    readonly code: WorkflowGraphContractIssueCode,
    readonly path: string,
    message: string,
  ) {
    super(`${message} at ${path}`);
    this.name = 'WorkflowGraphContractError';
  }
}
