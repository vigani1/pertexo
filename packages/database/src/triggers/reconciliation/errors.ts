export class WorkflowTriggerReconciliationMismatchError extends Error {
  public override readonly name = 'WorkflowTriggerReconciliationMismatchError';
}

export class WorkflowTriggerStalePublicationError extends Error {
  public override readonly name = 'WorkflowTriggerStalePublicationError';
}
