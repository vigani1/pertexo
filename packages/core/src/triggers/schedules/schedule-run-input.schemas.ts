import { z } from 'zod';

/** The widest node id a schedule's run input names. */
const NODE_ID_MAX_CHARACTERS = 128;

export const scheduleRunInputSchema = z
  .object({
    triggerId: z.uuid(),
    nodeId: z.string().trim().min(1).max(NODE_ID_MAX_CHARACTERS),
    scheduledAt: z.iso.datetime({ offset: true }),
  })
  .strict();
