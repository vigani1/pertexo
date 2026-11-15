/** A run's stored state refused a change: the run is gone, terminal or past a deadline. */
export class ExecutionStateConflictError extends Error {
  public override readonly name: string = 'ExecutionStateConflictError';
}
