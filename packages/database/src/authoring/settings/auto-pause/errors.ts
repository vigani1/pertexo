export class WorkflowPauseRevisionConflictError extends Error {
  public override readonly name = 'WorkflowPauseRevisionConflictError';
  public constructor(public readonly currentRevision: string) {
    super('Workflow pause revision does not match');
  }
}

export class WorkflowAutoPauseSettingsRevisionConflictError extends Error {
  public override readonly name =
    'WorkflowAutoPauseSettingsRevisionConflictError';
  public constructor(public readonly currentRevision: number) {
    super('Workflow auto pause settings revision does not match');
  }
}

export class WorkspaceAutoPauseSettingsRevisionConflictError extends Error {
  public override readonly name =
    'WorkspaceAutoPauseSettingsRevisionConflictError';
  public constructor(public readonly currentRevision: number) {
    super('Workspace auto pause settings revision does not match');
  }
}
