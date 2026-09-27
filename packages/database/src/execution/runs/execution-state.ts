export class ExecutionStateConflictError extends Error {
  public override readonly name: string = 'ExecutionStateConflictError';
}

export class RunEventGapError extends ExecutionStateConflictError {
  public override readonly name = 'RunEventGapError';

  public constructor() {
    super('execution.run_event_gap');
  }
}
