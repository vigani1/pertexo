import { NODE_FAILURE_FIELD_LIMITS } from '@pertexo/node-sdk';
import { responseSchema } from '../shared/response-schema.js';
import { boundedNodeTestJsonInputSchema } from '../shared/bounded-json-input.js';
import { eventCoordinationReceiptSchema } from '@pertexo/workflow-model';
import { coordinatedEventSchema } from '../forms/coordination.js';
import { z } from 'zod';
import { webhookAuthenticationSchema } from '@pertexo/workflow-model';

const WEBHOOKS_BOUNDS = Object.freeze({
  // Wider than the graph's 64-character node id on purpose: a response must carry any id storage holds.
  nodeIdCharacters: 256,
  lastErrorCodeCharacters: NODE_FAILURE_FIELD_LIMITS.safeErrorCodeCharacters,
  webhookTriggerListPageItems: 1000,
  webhookDeliveryCursorCharacters: 512,
  webhookDeliveryPageLimitMaximum: 100,
  webhookDeliveryListPageItems: 100,
});

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

/** The largest webhook or callback request body Pertexo accepts. */
export const WEBHOOK_BODY_MAX_BYTES = 256 * 1024;

/** How far a signed delivery's timestamp may be from now, in seconds. */
export const WEBHOOK_FRESHNESS_ALLOWANCE_SECONDS = 300;

export const webhookTriggerHealthSchema = z
  .object({
    id: z.uuid(),
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
    nodeId: z.string().min(1).max(WEBHOOKS_BOUNDS.nodeIdCharacters),
    kind: z.literal('webhook'),
    status: webhookTriggerStatusSchema,
    healthStatus: webhookTriggerHealthStatusSchema,
    lastErrorCode: z
      .string()
      .max(WEBHOOKS_BOUNDS.lastErrorCodeCharacters)
      .nullable(),
    endpointReady: z.boolean(),
    authentication: webhookAuthenticationSchema,
    reconciledAt: z.iso.datetime().nullable(),
  })
  .strict();
export const webhookTriggerListResponseSchema = responseSchema(
  z
    .object({
      items: z
        .array(webhookTriggerHealthSchema)
        .max(WEBHOOKS_BOUNDS.webhookTriggerListPageItems),
    })
    .strict(),
);
export const webhookRotateSecretRequestSchema = z
  .object({ endpointKey: webhookCredentialSchema })
  .strict();
export const webhookManagementCommandResponseSchema = responseSchema(
  z.discriminatedUnion('replayed', [
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
  ]),
);
export const webhookIngressResponseSchema = responseSchema(
  z
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
    .or(eventCoordinationReceiptSchema),
);

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
const webhookDeliveryCursorSchema = z
  .string()
  .min(1)
  .max(WEBHOOKS_BOUNDS.webhookDeliveryCursorCharacters);
const webhookDeliveryPageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(WEBHOOKS_BOUNDS.webhookDeliveryPageLimitMaximum);
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
    byteLength: z.number().int().min(0).max(WEBHOOK_BODY_MAX_BYTES).nullable(),
    runId: z.uuid().nullable(),
    skipReason: z.literal('concurrency_limit').optional(),
    coordination: coordinatedEventSchema.optional(),
  })
  .strict();
export const webhookDeliveryListResponseSchema = responseSchema(
  z
    .object({
      items: z
        .array(webhookDeliverySchema)
        .max(WEBHOOKS_BOUNDS.webhookDeliveryListPageItems),
      nextCursor: webhookDeliveryCursorSchema.nullable(),
    })
    .strict(),
);

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
export const webhookTestEventStartedSchema = responseSchema(
  z
    .object({
      id: z.uuid(),
      path: z.string().regex(/^\/hooks\/[A-Za-z0-9_-]{43}\/test$/u),
      expiresAt: z.iso.datetime(),
      signingSecret: webhookCredentialSchema.optional(),
      authentication: webhookAuthenticationSchema,
    })
    .strict(),
);
export const webhookTestEventSnapshotSchema = responseSchema(
  z
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
    .strict(),
);
export type WebhookTestEventStarted = z.output<
  typeof webhookTestEventStartedSchema
>;
export type WebhookTestEventSnapshot = z.output<
  typeof webhookTestEventSnapshotSchema
>;
