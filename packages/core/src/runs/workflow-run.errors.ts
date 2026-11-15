export class WorkflowRunNotFoundError extends Error {
  public override readonly name = 'WorkflowRunNotFoundError';
}

/** A run the caller cannot see reads the same as one that does not exist. */
export function requireWorkflowRun<T>(run: T | undefined): T {
  if (run === undefined) throw new WorkflowRunNotFoundError();
  return run;
}

export class WorkflowRunNotExecutableError extends Error {
  public override readonly name = 'WorkflowRunNotExecutableError';
}

export class WorkflowRunReadCapacityError extends Error {
  public override readonly name = 'WorkflowRunReadCapacityError';
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
