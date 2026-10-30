import { z } from 'zod';

import { QueueConfigurationError } from '../publication/errors.js';

/** The BullMQ job ID of one outbox event; a UUID keeps it nonnumeric and colon-free. */
export function jobIdForOutboxEvent(outboxEventId: string): string {
  const parsed = z.uuid().safeParse(outboxEventId);

  if (!parsed.success) {
    throw new QueueConfigurationError('Outbox event ID must be a UUID');
  }

  return `outbox-${parsed.data}`;
}
