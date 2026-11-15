import { WorkflowNotFoundError } from '../workflows/workflow-authoring.errors.js';

export class WorkflowCollaborationError extends Error {
  override readonly name = 'WorkflowCollaborationError';
  constructor(
    readonly reason: 'conflict' | 'forbidden' | 'limit' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

/** A discussion the caller cannot see reads the same as one that does not exist. */
export function requireThread<T>(thread: T | undefined): T {
  if (thread === undefined)
    throw new WorkflowNotFoundError('Discussion is not visible');
  return thread;
}
