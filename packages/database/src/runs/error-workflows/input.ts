import { z } from 'zod';

export const errorWorkflowDeliveryInputSchema = z
  .object({
    workspaceId: z.uuid(),
    sourceRunId: z.uuid(),
    outboxEventId: z.uuid(),
    payloadChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
    signal: z.instanceof(AbortSignal),
    traceparent: z.string().optional(),
  })
  .strict();
