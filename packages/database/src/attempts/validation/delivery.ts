import { z } from 'zod';

import {
  identitySchema,
  workerIdSchema,
  deliverySchema,
  nodeIdSchema,
  invocationKeySchema,
  NODE_ATTEMPT_INPUT_LIMITS,
  sideEffectClassSchema,
  admissionKindSchema,
  branchScopePartSchema,
  iterationScopePartSchema,
  providerDispatchBindingSchema,
  connectionDispatchFenceSchema,
} from './shared.js';

export const claimDeliverySchema = z
  .object({
    workspaceId: identitySchema,
    runId: identitySchema,
    nodeRunId: identitySchema,
    attemptId: identitySchema,
    delivery: deliverySchema,
    leaseDurationSeconds: z.number().int().min(1).max(300),
    workerId: workerIdSchema,
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();

export const attemptJobPayloadSchema = z
  .object({
    workspaceId: identitySchema,
    runId: identitySchema,
    nodeRunId: identitySchema,
    attemptId: identitySchema,
    outboxEventId: identitySchema,
    traceparent: z
      .string()
      .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
      .optional(),
  })
  .strict();

const nodeAttemptLeaseSchema = z
  .object({
    workspaceId: identitySchema,
    runId: identitySchema,
    workflowVersionId: identitySchema,
    nodeRunId: identitySchema,
    attemptId: identitySchema,
    attemptNumber: z.number().int().positive(),
    admissionKind: admissionKindSchema,
    invocationKey: invocationKeySchema,
    nodeId: nodeIdSchema,
    branchPath: z.array(branchScopePartSchema).min(1).max(1_000).optional(),
    iterationPath: z
      .array(iterationScopePartSchema)
      .min(1)
      .max(1_000)
      .optional(),
    sideEffectClass: sideEffectClassSchema,
    providerIdempotencyKey: z.string().min(1).max(256).optional(),
    providerDispatchBinding: providerDispatchBindingSchema.optional(),
    providerDispatchUnresolved: z.literal(true).optional(),
    workerId: workerIdSchema,
    fenceToken: z.number().int().positive(),
    leaseExpiresAt: z.date(),
    delivery: deliverySchema,
  })
  .strict();

export const loadInputsSchema = z
  .object({
    lease: nodeAttemptLeaseSchema,
    sourceFailure: z
      .object({ nodeId: nodeIdSchema, invocationKey: invocationKeySchema })
      .strict()
      .optional(),
    upstreamNodeOutputs: z
      .array(
        z
          .object({
            nodeId: nodeIdSchema,
            invocationKey: invocationKeySchema,
          })
          .strict(),
      )
      .max(NODE_ATTEMPT_INPUT_LIMITS.upstreamNodeOutputs)
      .refine(
        (values) =>
          new Set(values.map(({ invocationKey }) => invocationKey)).size ===
          values.length,
      ),
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();

export const ownedLeaseSchema = z
  .object({
    lease: nodeAttemptLeaseSchema,
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();

export const dispatchSchema = ownedLeaseSchema
  .extend({
    connectionFence: connectionDispatchFenceSchema.optional(),
    providerDispatchBinding: providerDispatchBindingSchema.optional(),
  })
  .strict();

export const recordInputSchema = ownedLeaseSchema
  .extend({ input: z.unknown() })
  .strict();

export const heartbeatSchema = ownedLeaseSchema
  .extend({ leaseDurationSeconds: z.number().int().min(1).max(300) })
  .strict();
