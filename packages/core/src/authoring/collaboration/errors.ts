export class WorkflowCollaborationError extends Error {
  override readonly name = 'WorkflowCollaborationError';
  constructor(
    readonly reason: 'conflict' | 'forbidden' | 'limit' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}
