import { z } from 'zod';
import { traceparentSchema } from './input.js';

export const previewConsumerName = 'preview-attempt-worker';

export const previewReconcilerConsumerName = 'preview-attempt-reconciler';

export const previewDeliveryPayloadSchema = z
  .object({
    workspaceId: z.uuid(),
    outboxEventId: z.uuid(),
    previewRunId: z.uuid(),
    previewAttemptId: z.uuid(),
    traceparent: traceparentSchema,
  })
  .strict();

export const previewReconciliationPayloadSchema = z
  .object({
    workspaceId: z.uuid(),
    outboxEventId: z.uuid(),
    previewRunId: z.uuid(),
    previewAttemptId: z.uuid(),
    attemptFenceToken: z.number().int().nonnegative(),
    traceparent: traceparentSchema,
  })
  .strict();
