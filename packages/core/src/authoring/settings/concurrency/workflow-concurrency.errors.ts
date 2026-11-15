export class WorkflowConcurrencyRevisionConflictError extends Error {
  public override readonly name = 'WorkflowConcurrencyRevisionConflictError';
  public constructor(public readonly currentRevision: number) {
    super('Workflow concurrency revision does not match');
  }
}

export class WorkflowConcurrencyLimitUnavailableError extends Error {
  public override readonly name = 'WorkflowConcurrencyLimitUnavailableError';
  public constructor() {
    super('Active workspace entitlement required');
  }
}

export class WorkflowConcurrencyLimitExceededError extends Error {
  public override readonly name = 'WorkflowConcurrencyLimitExceededError';
  public constructor(public readonly maximum: number) {
    super('Workflow concurrency limit exceeds workspace capacity');
  }
}
