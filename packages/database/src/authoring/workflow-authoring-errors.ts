export class WorkflowNotFoundError extends Error {
  public override readonly name = 'WorkflowNotFoundError';
}

export class WorkflowDraftOperationUnavailableError extends Error {
  public override readonly name = 'WorkflowDraftOperationUnavailableError';
  public constructor() {
    super('This operation is not enabled for native workflow drafts.');
  }
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

export class WorkflowNameRevisionConflictError extends Error {
  public override readonly name = 'WorkflowNameRevisionConflictError';
  public constructor(public readonly currentRevision: number) {
    super('Workflow name revision does not match');
  }
}

export class WorkflowIdempotencyConflictError extends Error {
  public override readonly name = 'WorkflowIdempotencyConflictError';
}

export class WorkflowPortabilityUnavailableError extends Error {
  public override readonly name = 'WorkflowPortabilityUnavailableError';
}

export class WorkflowTemplateOriginUnavailableError extends Error {
  public override readonly name = 'WorkflowTemplateOriginUnavailableError';
  public constructor() {
    super('Historical template origin is unavailable');
  }
}

export class WorkflowPortabilityCompatibilityConflictError extends Error {
  public override readonly name =
    'WorkflowPortabilityCompatibilityConflictError';
}

export class WorkflowPortabilityReviewConflictError extends Error {
  public override readonly name = 'WorkflowPortabilityReviewConflictError';
}

export class WorkflowPortabilityValidationError extends Error {
  public override readonly name = 'WorkflowPortabilityValidationError';
  public constructor(
    public readonly issues: readonly Readonly<{
      code: string;
      path: string;
      message: string;
    }>[],
    public readonly truncated = false,
  ) {
    super('Workflow portability input is not compatible');
  }
}
