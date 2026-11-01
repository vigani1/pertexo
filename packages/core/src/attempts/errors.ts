export class NodeAttemptDeliveryMismatchError extends Error {
  public override readonly name = 'NodeAttemptDeliveryMismatchError';
  public constructor() {
    super('Node attempt delivery does not match its durable outbox identity');
  }
}

export class NodeAttemptReconciliationRequiredError extends Error {
  public override readonly name = 'NodeAttemptReconciliationRequiredError';
  public constructor() {
    super('Node attempt requires lease reconciliation before execution');
  }
}

export class NodeAttemptDispatchBindingMismatchError extends Error {
  public override readonly name = 'NodeAttemptDispatchBindingMismatchError';
  public constructor() {
    super('Node attempt provider dispatch binding does not match');
  }
}

export class NodeAttemptConnectionFenceError extends Error {
  public override readonly name = 'NodeAttemptConnectionFenceError';
  public constructor() {
    super('Node attempt connection fence does not match current active state');
  }
}

export class NodeAttemptStateCorruptError extends Error {
  public override readonly name = 'NodeAttemptStateCorruptError';
  public constructor() {
    super('Persisted node attempt state is invalid');
  }
}

export class NodeAttemptOutputInvalidError extends Error {
  public override readonly name = 'NodeAttemptOutputInvalidError';
  public constructor(options?: ErrorOptions) {
    super(
      'Node attempt output violates the inline execution-value contract',
      options,
    );
  }
}

export class DeliveryMismatch extends Error {}

export class ExecutionCapabilityExpiredError extends Error {
  override readonly name = 'ExecutionCapabilityExpiredError';
  constructor(message = 'This execution attempt is no longer current.') {
    super(message);
  }
}
