import { boundedNodeTestJsonInputSchema } from '../shared/bounded-json-input.js';
import { eventCoordinationReceiptSchema } from '@pertexo/workflow-model';
import { coordinatedEventSchema } from '../forms/coordination.js';
import { z } from 'zod';
import { webhookAuthenticationSchema } from '@pertexo/workflow-model';

const webhookCredentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const webhookTriggerStatusSchema = z.enum([
  'desired',
  'configuration_required',
  'pending',
  'active',
  'degraded',
  'disabled',
  'error',
]);
const webhookTriggerHealthStatusSchema = z.enum([
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
    authentication: webhookAuthenticationSchema,
    reconciledAt: z.iso.datetime().nullable(),
  })
  .strict();
export const webhookTriggerListResponseSchema = z
  .object({ items: z.array(webhookTriggerHealthSchema).max(1_000) })
  .strict();
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
  .strict()
  .or(
    z
      .object({
        skipped: z.literal(true),
        reason: z.literal('concurrency_limit'),
      })
      .strict(),
  )
  .or(eventCoordinationReceiptSchema);

/**
 * ADR 045: what happened to one attributed request, metadata only. ADR 056
 * adds `paused`: a verified delivery refused with 423 while the workflow's
 * triggers are paused.
 */
const webhookDeliveryOutcomeSchema = z.enum([
  'accepted',
  'coordinated',
  'skipped',
  'replayed',
  'authentication_failed',
  'invalid_request',
  'conflict',
  'rate_limited',
  'paused',
]);
const webhookDeliverySignatureCheckSchema = z.enum([
  'verified',
  'mismatch',
  'not_checked',
]);
const webhookDeliveryReplayCheckSchema = z.enum([
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
    skipReason: z.literal('concurrency_limit').optional(),
    coordination: coordinatedEventSchema.optional(),
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

export const webhookTestEventStartSchema = z
  .object({
    expectedDraftRevision: z.number().int().min(1),
    authentication: webhookAuthenticationSchema,
  })
  .strict();
export const webhookTestEventStartedSchema = z
  .object({
    id: z.uuid(),
    path: z.string().regex(/^\/hooks\/[A-Za-z0-9_-]{43}\/test$/u),
    expiresAt: z.iso.datetime(),
    signingSecret: webhookCredentialSchema.optional(),
    authentication: webhookAuthenticationSchema,
  })
  .strict();
export const webhookTestEventSnapshotSchema = z
  .object({
    state: z.enum(['waiting', 'captured', 'expired', 'changed']),
    expiresAt: z.iso.datetime().nullable(),
    output: z
      .object({
        kind: z.literal('inline'),
        value: boundedNodeTestJsonInputSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type WebhookTestEventStarted = z.output<
  typeof webhookTestEventStartedSchema
>;
export type WebhookTestEventSnapshot = z.output<
  typeof webhookTestEventSnapshotSchema
>;
