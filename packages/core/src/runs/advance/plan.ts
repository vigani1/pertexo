import { z } from 'zod';

export const scheduleRunInputSchema = z
  .object({
    triggerId: z.uuid(),
    nodeId: z.string().trim().min(1).max(128),
    scheduledAt: z.iso.datetime({ offset: true }),
  })
  .strict();
