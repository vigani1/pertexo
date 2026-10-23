export class QueueConfigurationError extends Error {
  public override readonly name = 'QueueConfigurationError';

  public constructor(message: string) {
    super(message);
  }
}

export class QueueNotReadyError extends Error {
  public override readonly name = 'QueueNotReadyError';

  public constructor() {
    super('Queue producer Redis connection is not ready');
  }
}
