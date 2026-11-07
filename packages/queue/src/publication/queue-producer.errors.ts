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

export class QueuePublicationUnavailableError extends Error {
  public override readonly name = 'QueuePublicationUnavailableError';

  public constructor() {
    super(
      'Redis cannot accept queue writes. Check Redis memory limits and persistence disk errors, then retry the readiness check.',
    );
  }
}
