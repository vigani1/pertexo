export class WorkflowNotFoundError extends Error {
  public override readonly name = 'WorkflowNotFoundError';
}

export class WorkflowRevisionConflictError extends Error {
  public override readonly name = 'WorkflowRevisionConflictError';
  public constructor(
    public readonly currentRevision: number,
    public readonly currentEtag: string,
  ) {
    super('Workflow draft revision does not match');
  }
}

export class WorkflowLifecycleRevisionConflictError extends Error {
  public override readonly name = 'WorkflowLifecycleRevisionConflictError';
  public constructor(public readonly currentRevision: number) {
    super('Workflow lifecycle revision does not match');
  }
}

export class WorkflowIdempotencyConflictError extends Error {
  public override readonly name = 'WorkflowIdempotencyConflictError';
}
