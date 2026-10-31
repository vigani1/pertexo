import { canonicalOutboxPayloadChecksum } from '@pertexo/database/outbox';
import type { LeasedOutboxEvent } from '@pertexo/database/outbox';
import type { TransportErrorClass, TransportJob } from '@pertexo/observability';
import {
  JOB_NAME,
  QueueNotReadyError,
  parseQueueJob,
  type QueueJob,
  type JobName,
} from '@pertexo/queue';

import { transportJobForName } from '../../job.js';

import { TransportOperationTimeoutError } from '../operation-deadline.js';
import { OutboxPayloadChecksumError, OutboxContractError } from './errors.js';

export function transportJobName(jobName: string): TransportJob | undefined {
  return Object.values<string>(JOB_NAME).includes(jobName)
    ? transportJobForName(jobName as JobName)
    : undefined;
}

export function transportErrorClass(error: unknown): TransportErrorClass {
  if (
    error instanceof OutboxPayloadChecksumError ||
    error instanceof OutboxContractError
  ) {
    return 'contract';
  }
  if (error instanceof TransportOperationTimeoutError) {
    return 'timeout';
  }
  if (error instanceof QueueNotReadyError) {
    return 'unavailable';
  }
  return 'redis';
}

export function toQueueJob(event: LeasedOutboxEvent): QueueJob {
  if (canonicalOutboxPayloadChecksum(event.payload) !== event.payloadChecksum) {
    throw new OutboxPayloadChecksumError(event.id);
  }
  if (
    typeof event.payload !== 'object' ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    throw new OutboxContractError(
      event.id,
      new TypeError('Payload is not an object'),
    );
  }

  try {
    return parseQueueJob({
      name: event.jobName,
      data: {
        ...event.payload,
        outboxEventId: event.id,
        workspaceId: event.workspaceId,
      },
    });
  } catch (error: unknown) {
    throw new OutboxContractError(event.id, error);
  }
}

/** Only a broken row is final: an infrastructure failure, however long, retries. */
export function canNeverPublish(error: unknown): boolean {
  return (
    error instanceof OutboxPayloadChecksumError ||
    error instanceof OutboxContractError
  );
}

/** Long enough to stop hammering Redis, short enough to resume soon after it returns. */
const MAXIMUM_PUBLICATION_RETRY_DELAY_MILLIS = 30_000;

export function publicationRetryDelay(
  baseDelayMillis: number,
  publishAttempts: number,
): number {
  const doublings = Math.min(Math.max(publishAttempts - 1, 0), 16);
  return Math.min(
    baseDelayMillis * 2 ** doublings,
    MAXIMUM_PUBLICATION_RETRY_DELAY_MILLIS,
  );
}

export function errorCode(error: unknown): string {
  if (error instanceof OutboxPayloadChecksumError) {
    return 'outbox.checksum_mismatch';
  }
  if (error instanceof OutboxContractError) {
    return 'outbox.invalid_contract';
  }
  return 'queue.publish_failed';
}
