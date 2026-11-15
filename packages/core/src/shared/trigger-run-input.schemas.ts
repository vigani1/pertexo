import { WORKFLOW_GRAPH_CONTRACT_LIMITS } from '@pertexo/workflow-model';
import { z } from 'zod';

/** The stored input of a run a schedule started: triggers write it, runs read it back. */
export const scheduleRunInputSchema = z
  .object({
    triggerId: z.uuid(),
    nodeId: z
      .string()
      .trim()
      .min(1)
      .max(WORKFLOW_GRAPH_CONTRACT_LIMITS.identifierLength),
    scheduledAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ScheduleRunInput = z.input<typeof scheduleRunInputSchema>;
