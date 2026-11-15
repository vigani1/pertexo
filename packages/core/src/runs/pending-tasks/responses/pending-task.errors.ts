export class PendingTaskNotFoundError extends Error {
  override readonly name = 'PendingTaskNotFoundError';
}

export class PendingTaskDecisionError extends Error {
  override readonly name = 'PendingTaskDecisionError';
  constructor(
    readonly reason:
      | 'resolved'
      | 'expired'
      | 'run_closed'
      | 'starter'
      | 'audience'
      | 'workspace_suspended',
  ) {
    super('This task cannot be decided.');
  }
}

/** A task row the caller cannot see reads the same as one that does not exist. */
export function requireVisibleTask<T>(row: T | undefined): T {
  if (row === undefined)
    throw new PendingTaskNotFoundError('Task is not visible.');
  return row;
}
