import type { WorkflowDefinitionPlacementIssue } from '@pertexo/workflow-model';
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

export class WorkflowNameRevisionConflictError extends Error {
  public override readonly name = 'WorkflowNameRevisionConflictError';
  public constructor(public readonly currentRevision: number) {
    super('Workflow name revision does not match');
  }
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
  public readonly truncated: boolean;
  public override readonly name = 'WorkflowPortabilityValidationError';
  public constructor(
    public readonly issues: readonly Readonly<{
      code: string;
      path: string;
      message: string;
    }>[],
    { truncated = false }: Readonly<{ truncated?: boolean | undefined }> = {},
  ) {
    super('Workflow portability input is not compatible');
    this.truncated = truncated;
  }
}

export class WorkflowDefinitionPlacementError extends Error {
  public override readonly name = 'WorkflowDefinitionPlacementError';

  public constructor(
    public readonly issues: readonly WorkflowDefinitionPlacementIssue[],
  ) {
    super('Workflow draft adds a definition that is not placeable');
  }
}
