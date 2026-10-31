import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';

import { parseQueueJob, type QueueJob } from './contracts.js';
import { isJobIdOfOutboxEvent } from './job-id.js';
import { QUEUE_FOR_JOB, type QueueName } from './names.js';

/** An invalid delivery cannot become valid through transport redelivery. */
export class InvalidQueueDeliveryError extends UnrecoverableError {
  public override readonly name = 'InvalidQueueDeliveryError';
}

/** Validate the envelope and its transport identity before starting a handler. */
export function admitQueueDelivery(
  queueName: QueueName,
  job: Pick<Job<unknown, unknown>, 'name' | 'data' | 'id'>,
): Readonly<{ parsed: QueueJob; transportJobId: string }> {
  let parsed: QueueJob;
  try {
    parsed = parseQueueJob({ name: job.name, data: job.data });
  } catch (error: unknown) {
    throw new InvalidQueueDeliveryError(
      error instanceof Error ? error.message : 'Queue delivery is invalid',
    );
  }
  if (QUEUE_FOR_JOB[parsed.name] !== queueName)
    throw new InvalidQueueDeliveryError(
      `Job ${parsed.name} cannot be delivered by queue ${queueName}`,
    );
  if (typeof job.id !== 'string' || job.id.length === 0)
    throw new InvalidQueueDeliveryError('Queue delivery has no job ID');
  const transportJobId = job.id;
  if (!isJobIdOfOutboxEvent(transportJobId, parsed.data.outboxEventId))
    throw new InvalidQueueDeliveryError(
      'Queue delivery job ID does not match its outbox event',
    );
  return { parsed, transportJobId };
}

/** What an operator needs to find the run a failed delivery stopped. */
export function deliveryIdentity(
  parsed: QueueJob,
  job: Pick<Job<unknown, unknown>, 'attemptsMade'>,
): Readonly<{
  attemptsMade: number;
  outboxEventId: string;
  runId?: string;
  workspaceId: string;
}> {
  return {
    attemptsMade: job.attemptsMade,
    outboxEventId: parsed.data.outboxEventId,
    workspaceId: parsed.data.workspaceId,
    ...('runId' in parsed.data ? { runId: parsed.data.runId } : {}),
  };
}
