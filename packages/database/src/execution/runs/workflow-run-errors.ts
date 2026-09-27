export class WorkflowRunNotFoundError extends Error {
  public override readonly name = 'WorkflowRunNotFoundError';
}

export class WorkflowRunNotExecutableError extends Error {
  public override readonly name = 'WorkflowRunNotExecutableError';
}

export class WorkflowRunReadCapacityError extends Error {
  public override readonly name = 'WorkflowRunReadCapacityError';
}
