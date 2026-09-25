import { z } from 'zod';

export const webhookCredentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const webhookTriggerStatusSchema = z.enum([
  'desired',
  'configuration_required',
  'pending',
  'active',
  'degraded',
  'disabled',
  'error',
]);
export const webhookTriggerHealthStatusSchema = z.enum([
  'pending',
  'healthy',
  'degraded',
  'unhealthy',
  'disabled',
]);
export const webhookTriggerHealthSchema = z
  .object({
    id: z.uuid(),
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
    nodeId: z.string().min(1).max(256),
    kind: z.literal('webhook'),
    status: webhookTriggerStatusSchema,
    healthStatus: webhookTriggerHealthStatusSchema,
    lastErrorCode: z.string().max(128).nullable(),
    endpointReady: z.boolean(),
    reconciledAt: z.iso.datetime().nullable(),
  })
  .strict();
export const webhookTriggerListResponseSchema = z
  .object({ items: z.array(webhookTriggerHealthSchema).max(1_000) })
  .strict();
export const webhookManagementCommandRequestSchema = z.object({}).strict();
export const webhookRotateSecretRequestSchema = z
  .object({ endpointKey: webhookCredentialSchema })
  .strict();
export const webhookManagementCommandResponseSchema = z.discriminatedUnion(
  'replayed',
  [
    z
      .object({
        trigger: webhookTriggerHealthSchema,
        replayed: z.literal(true),
        endpointKey: z.never().optional(),
        signingSecret: z.never().optional(),
      })
      .strict(),
    z
      .object({
        trigger: webhookTriggerHealthSchema,
        replayed: z.literal(false),
        endpointKey: webhookCredentialSchema.optional(),
        signingSecret: webhookCredentialSchema.optional(),
      })
      .strict(),
  ],
);
export const webhookIngressResponseSchema = z
  .object({ runId: z.uuid(), replayed: z.boolean() })
  .strict();

/** ADR 045: what happened to one attributed request, metadata only. */
export const webhookDeliveryOutcomeSchema = z.enum([
  'accepted',
  'replayed',
  'authentication_failed',
  'invalid_request',
  'conflict',
  'rate_limited',
]);
export const webhookDeliverySignatureCheckSchema = z.enum([
  'verified',
  'mismatch',
  'not_checked',
]);
export const webhookDeliveryReplayCheckSchema = z.enum([
  'new',
  'duplicate',
  'conflict',
  'stale_timestamp',
  'not_checked',
]);
export const webhookDeliveryCursorSchema = z.string().min(1).max(512);
export const webhookDeliveryPageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(100);
export const webhookDeliveryListQuerySchema = z
  .object({
    limit: webhookDeliveryPageLimitSchema.optional(),
    after: webhookDeliveryCursorSchema.optional(),
  })
  .strict();
export const webhookDeliverySchema = z
  .object({
    id: z.uuid(),
    receivedAt: z.iso.datetime(),
    outcome: webhookDeliveryOutcomeSchema,
    httpStatus: z.number().int().min(200).max(599),
    signatureCheck: webhookDeliverySignatureCheckSchema,
    replayCheck: webhookDeliveryReplayCheckSchema,
    byteLength: z.number().int().min(0).max(262_144).nullable(),
    runId: z.uuid().nullable(),
  })
  .strict();
export const webhookDeliveryListResponseSchema = z
  .object({
    items: z.array(webhookDeliverySchema).max(100),
    nextCursor: webhookDeliveryCursorSchema.nullable(),
  })
  .strict();

export type WebhookTriggerHealthResponse = z.output<
  typeof webhookTriggerHealthSchema
>;
export type WebhookDeliveryResponse = z.output<typeof webhookDeliverySchema>;
export type WebhookDeliveryListResponse = z.output<
  typeof webhookDeliveryListResponseSchema
>;
export type WebhookManagementCommandResponse = z.output<
  typeof webhookManagementCommandResponseSchema
>;
