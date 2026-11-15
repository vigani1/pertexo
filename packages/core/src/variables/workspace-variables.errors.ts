export class WorkspaceVariablesConflictError extends Error {
  override readonly name = 'WorkspaceVariablesConflictError';
}

export class WorkspaceVariableUsageChangedError extends Error {
  override readonly name = 'WorkspaceVariableUsageChangedError';
}
