export class ExecutionStateConflictError extends Error {
  public override readonly name: string = 'ExecutionStateConflictError';
}

export class RunEventGapError extends ExecutionStateConflictError {
  public override readonly name = 'RunEventGapError';

  public constructor() {
    super('execution.run_event_gap');
  }
}

export class CoordinatorRunStateCorruptError extends Error {
  public override readonly name = 'CoordinatorRunStateCorruptError';
  public constructor() {
    super('Persisted coordinator run state is invalid');
  }
}

export class CoordinatorDeliveryMismatchError extends Error {
  public override readonly name = 'CoordinatorDeliveryMismatchError';
  public constructor() {
    super('Coordinator delivery does not match its durable outbox identity');
  }
}
