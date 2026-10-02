export class WorkflowOrganizationUnavailableError extends Error {
  override readonly name = 'WorkflowOrganizationUnavailableError';
  constructor() {
    super('Workflow organization is unavailable');
  }
}

export class WorkflowOrganizationValidationError extends Error {
  override readonly name = 'WorkflowOrganizationValidationError';
  constructor() {
    super('Workflow organization command is invalid');
  }
}
