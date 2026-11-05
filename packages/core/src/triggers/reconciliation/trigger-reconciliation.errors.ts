export class WorkflowTriggerReconciliationMismatchError extends Error {
  public override readonly name = 'WorkflowTriggerReconciliationMismatchError';
}

export class WorkflowTriggerStalePublicationError extends Error {
  public override readonly name = 'WorkflowTriggerStalePublicationError';
}

/** Preserve the prior storage fence's retryable refusal at the worker boundary. */
export class WorkflowTriggerWorkspaceUnavailableError extends Error {
  public override readonly name = 'WorkflowTriggerWorkspaceUnavailableError';
  public readonly code = '55000';
  public constructor() {
    super('workspace integration is disabled');
  }
}
