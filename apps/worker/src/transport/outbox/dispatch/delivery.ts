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

export function errorCode(error: unknown): string {
  if (error instanceof OutboxPayloadChecksumError) {
    return 'outbox.checksum_mismatch';
  }
  if (error instanceof OutboxContractError) {
    return 'outbox.invalid_contract';
  }
  return 'queue.publish_failed';
}
