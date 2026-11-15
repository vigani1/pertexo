export class WorkflowErrorSettingsConflictError extends Error {
  public override readonly name = 'WorkflowErrorSettingsConflictError';
  public constructor(public readonly currentRevision: number) {
    super('Error workflow settings changed. Reload and try again.');
  }
}

export class WorkflowErrorTargetUnavailableError extends Error {
  public override readonly name = 'WorkflowErrorTargetUnavailableError';
  public constructor() {
    super(
      'Choose a different active workflow published with When a workflow fails.',
    );
  }
}
