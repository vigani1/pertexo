export class WorkflowCallsUnavailableError extends Error {
  override readonly name = 'WorkflowCallsUnavailableError';
  constructor() {
    super('Workflow Calls are temporarily unavailable.');
  }
}

export function mapWorkflowCallRolloutError(error: unknown): unknown {
  const seen = new Set<Error>();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(current instanceof Error) || seen.has(current)) return error;
    seen.add(current);
    try {
      if (
        Reflect.get(current, 'code') === '55000' &&
        current.message === 'workflow Calls are not enabled'
      )
        return new WorkflowCallsUnavailableError();
      current = current.cause;
    } catch {
      return error;
    }
  }
  return error;
}
