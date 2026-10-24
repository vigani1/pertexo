export class PendingTaskNotFoundError extends Error {
  override readonly name = 'PendingTaskNotFoundError';
}

export class PendingTaskDecisionError extends Error {
  override readonly name = 'PendingTaskDecisionError';
  constructor(
    readonly reason:
      'resolved' | 'expired' | 'run_closed' | 'starter' | 'audience',
  ) {
    super('This task cannot be decided.');
  }
}
