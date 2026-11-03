export class WorkflowInputCaseRevisionConflictError extends Error {
  override readonly name = 'WorkflowInputCaseRevisionConflictError';
  constructor(readonly currentRevision: number) {
    super('Run-input case revision changed');
  }
}

export class WorkflowInputCaseLimitError extends Error {
  override readonly name = 'WorkflowInputCaseLimitError';
  constructor(
    readonly kind: 'workflow_count' | 'workspace_count' | 'retained_bytes',
  ) {
    super('Run-input case storage limit reached');
  }
}
