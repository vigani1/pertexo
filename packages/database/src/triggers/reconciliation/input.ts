import { z } from 'zod';

export const uuidSchema = z.uuid();

export const reconciliationPayloadSchema = z
  .object({
    workspaceId: z.uuid(),
    outboxEventId: z.uuid(),
    workflowId: z.uuid(),
    publishedVersionId: z.uuid(),
    traceparent: z.string().optional(),
  })
  .strict();

export const safeReasonSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u);
