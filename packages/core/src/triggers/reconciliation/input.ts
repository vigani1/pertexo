import { z } from 'zod';

export const reconciliationPayloadSchema = z
  .object({
    workspaceId: z.uuid(),
    outboxEventId: z.uuid(),
    workflowId: z.uuid(),
    publishedVersionId: z.uuid(),
    traceparent: z.string().optional(),
  })
  .strict();
