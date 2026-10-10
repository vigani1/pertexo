import type { CallableValueIssue } from './validate-value.js';

export class CallableInputInvalidError extends TypeError {
  public override readonly name = 'CallableInputInvalidError';
  public constructor(
    readonly reason: 'missing' | 'bounds' | CallableValueIssue,
  ) {
    super('Workflow input does not satisfy its callable contract');
  }
}
