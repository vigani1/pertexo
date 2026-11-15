import { z } from 'zod';

import { TRIGGER_NODE_ID_MAX_CHARACTERS } from '../reconciliation/projection.js';

export const scheduleRunInputSchema = z
  .object({
    triggerId: z.uuid(),
    nodeId: z.string().trim().min(1).max(TRIGGER_NODE_ID_MAX_CHARACTERS),
    scheduledAt: z.iso.datetime({ offset: true }),
  })
  .strict();
