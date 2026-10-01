export class WorkflowRunNotFoundError extends Error {
  public override readonly name = 'WorkflowRunNotFoundError';
}

export class WorkflowRunNotExecutableError extends Error {
  public override readonly name = 'WorkflowRunNotExecutableError';
}

export class WorkflowRunReadCapacityError extends Error {
  public override readonly name = 'WorkflowRunReadCapacityError';
}

export class WorkflowManualStartUnavailableError extends Error {
  public override readonly name = 'WorkflowManualStartUnavailableError';
}

export class WorkflowPublishedVersionConflictError extends Error {
  public override readonly name = 'WorkflowPublishedVersionConflictError';
  public constructor(
    public readonly expectedPublishedVersionId: string,
    public readonly observedPublishedVersionId: string,
  ) {
    super('workflow.published_version_conflict');
  }
}
