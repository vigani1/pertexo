import type { NodeValidationIssue } from './validation.js';

export class NodeTestRequestError extends Error {
  public override readonly name = 'NodeTestRequestError';
  public constructor(
    public readonly code: 'idempotency_conflict' | 'idempotency_required',
  ) {
    super(
      code === 'idempotency_required'
        ? 'Idempotency-Key is required for test_execute'
        : 'request.idempotency_conflict',
    );
  }
}

export class NodeTestInvalidError extends Error {
  public override readonly name = 'NodeTestInvalidError';
  public constructor(public readonly issues: readonly NodeValidationIssue[]) {
    super('Selected node is not valid for preview');
  }
}
