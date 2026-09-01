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

export class WorkflowPublishIdempotencyConflictError extends Error {
  public override readonly name = 'WorkflowPublishIdempotencyConflictError';
}

export class WorkflowCreateIdempotencyConflictError extends Error {
  public override readonly name = 'WorkflowCreateIdempotencyConflictError';
}
