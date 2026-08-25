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
export const webhookManagementCommandResponseSchema = z
  .object({
    trigger: webhookTriggerHealthSchema,
    replayed: z.boolean(),
    endpointKey: webhookCredentialSchema.optional(),
    signingSecret: webhookCredentialSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.replayed &&
      (value.endpointKey !== undefined || value.signingSecret !== undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'Replays cannot disclose credentials',
      });
  });
export const webhookIngressResponseSchema = z
  .object({ runId: z.uuid(), replayed: z.boolean() })
  .strict();

export type WebhookTriggerHealthResponse = z.output<
  typeof webhookTriggerHealthSchema
>;
export type WebhookManagementCommandResponse = z.output<
  typeof webhookManagementCommandResponseSchema
>;
