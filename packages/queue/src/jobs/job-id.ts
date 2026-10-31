import { z } from 'zod';

import { QueueConfigurationError } from '../publication/errors.js';

/**
 * The BullMQ job ID of one delivery of an outbox event; a UUID keeps it nonnumeric
 * and colon-free. BullMQ ignores an add under an ID it retains, even one sitting
 * in its failed set, so a redelivery needs an ID of its own.
 */
export function jobIdForOutboxEvent(
  outboxEventId: string,
  redeliveries = 0,
): string {
  const parsed = z.uuid().safeParse(outboxEventId);

  if (!parsed.success) {
    throw new QueueConfigurationError('Outbox event ID must be a UUID');
  }

  return redeliveries === 0
    ? `outbox-${parsed.data}`
    : `outbox-${parsed.data}-r${String(redeliveries)}`;
}

/** Whether a job ID names some delivery of this outbox event. */
export function isJobIdOfOutboxEvent(
  jobId: string,
  outboxEventId: string,
): boolean {
  const firstDelivery = jobIdForOutboxEvent(outboxEventId);
  return (
    jobId === firstDelivery ||
    (jobId.startsWith(`${firstDelivery}-r`) &&
      /^[1-9]\d*$/u.test(jobId.slice(firstDelivery.length + 2)))
  );
}
