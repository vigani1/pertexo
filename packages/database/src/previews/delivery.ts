import { z } from 'zod';
import { traceparentSchema } from './input.js';
import { DELIVERY_CONSUMER } from '../outbox/delivery-consumers.js';

export const previewConsumerName = DELIVERY_CONSUMER['execute-preview-attempt'];

export const previewReconcilerConsumerName =
  DELIVERY_CONSUMER['reconcile-preview-attempt'];

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
