import { UnrecoverableError } from 'bullmq';

export class QueueConsumerConfigurationError extends Error {
  public override readonly name = 'QueueConsumerConfigurationError';
}

export class QueueConsumerNotReadyError extends Error {
  public override readonly name = 'QueueConsumerNotReadyError';

  public constructor() {
    super('Queue consumer Redis and BullMQ connections are not ready');
  }
}

export class QueueJobTimeoutError extends Error {
  public override readonly name = 'QueueJobTimeoutError';

  public constructor(timeoutMs: number) {
    super(
      `Queue handler exceeded its ${String(timeoutMs)}ms execution timeout`,
    );
  }
}

export class QueueConsumerDrainError extends Error {
  public override readonly name = 'QueueConsumerDrainError';

  public constructor() {
    super('Queue handler was aborted because bounded worker drain expired');
  }
}

/** An invalid delivery cannot become valid through transport redelivery. */
export class InvalidQueueDeliveryError extends UnrecoverableError {
  public override readonly name = 'InvalidQueueDeliveryError';
}
