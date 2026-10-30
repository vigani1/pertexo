import { UnrecoverableError } from 'bullmq';

import type {
  QueueConsumerOptions,
  QueueConsumer,
} from './consumption/contract.js';

import { BullMqQueueConsumer } from './consumption/runtime.js';
export { InvalidQueueDeliveryError } from './jobs/delivery-admission.js';
export {
  type QueueDeliveryTransport,
  type QueueDelivery,
  type QueueHandlerContext,
  type QueueJobHandler,
  type QueueHandlerFailureClass,
  type QueueHandlerObservation,
  type QueueTraceRunner,
  type QueueHandlerFinishedObservation,
  type QueueConsumerLifecycleObservation,
  type QueueStallObservation,
  type QueueConsumerObserver,
  type QueueConsumerOptions,
  type QueueConsumerCloseResult,
  type QueueConsumer,
} from './consumption/contract.js';
export {
  QueueConsumerConfigurationError,
  QueueConsumerNotReadyError,
  QueueJobTimeoutError,
  QueueConsumerDrainError,
} from './consumption/errors.js';
/**
 * Explicit policy seam for a handler that has already made the authoritative
 * PostgreSQL decision that this delivery must not be retried by BullMQ.
 */
export function unrecoverableQueueError(message: string): UnrecoverableError {
  return new UnrecoverableError(message);
}

export function createQueueConsumer(
  options: QueueConsumerOptions,
): QueueConsumer {
  return new BullMqQueueConsumer(options);
}
