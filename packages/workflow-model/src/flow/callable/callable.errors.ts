import type { CallableValueIssue } from './validate-value.js';

export class CallableInputInvalidError extends TypeError {
  public override readonly name = 'CallableInputInvalidError';
  public constructor(
    readonly reason: 'missing' | 'bounds' | CallableValueIssue,
  ) {
    super('Workflow input does not satisfy its callable contract');
  }
}

export class WorkflowCallDependencyError extends TypeError {
  public override readonly name = 'WorkflowCallDependencyError';
  public constructor(
    readonly code: 'workspace' | 'pin' | 'cycle' | 'expansion',
  ) {
    super('Workflow call dependencies do not satisfy the publication contract');
  }
}
