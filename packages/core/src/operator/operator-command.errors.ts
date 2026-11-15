export class OperatorCommandConflictError extends Error {
  public constructor() {
    super('Operator command replay conflicts with the existing request');
    this.name = 'OperatorCommandConflictError';
  }
}

export class OperatorRunReplayMismatchError extends Error {
  public constructor() {
    super('Run replay delivery does not match its durable request');
    this.name = 'OperatorRunReplayMismatchError';
  }
}

export class OperatorRunReplayNotExecutableError extends Error {
  public constructor() {
    super('Run replay target is not executable by this worker');
    this.name = 'OperatorRunReplayNotExecutableError';
  }
}
