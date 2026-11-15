import { z } from 'zod';

import { WORKFLOW_GRAPH_CONTRACT_LIMITS } from '@pertexo/workflow-model';

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
