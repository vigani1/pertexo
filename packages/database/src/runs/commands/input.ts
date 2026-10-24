import type { InitialCheckpointFactory } from './initial-checkpoint.js';
import { z } from 'zod';
import { sha256HexSchema as digestSchema } from '../../platform/persisted-primitives.js';
import type { WorkflowRecoveryPreparation } from '../recovery/contract.js';

const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16));

const actorSchema = z.uuid();

const requestIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);

export const startInputSchema = z
  .object({
    actorId: actorSchema,
    workspaceId: z.uuid(),
    workflowId: z.uuid(),
    idempotencyKeyHash: digestSchema,
    requestHash: digestSchema,
    scope: z
      .string()
      .regex(/^(?:workflow:[0-9a-f-]{36}:manual|api_token:[0-9a-f]{64})$/u),
    input: z.unknown().optional(),
    expectedPublishedVersionId: z.uuid().optional(),
    deadlineAt: z.date().optional(),
    requestId: requestIdentifierSchema.optional(),
    traceId: requestIdentifierSchema.optional(),
    traceparent: traceparentSchema.optional(),
    signal: z.instanceof(AbortSignal).optional(),
    checkpointFactory: z.custom<InitialCheckpointFactory>(
      (value) => typeof value === 'function',
    ),
  })
  .strict();

export const replayInputSchema = z
  .object({
    actorId: actorSchema,
    workspaceId: z.uuid(),
    sourceRunId: z.uuid(),
    workflowVersionId: z.uuid(),
    idempotencyKeyHash: digestSchema,
    requestHash: digestSchema,
    scope: z.string().regex(/^workflow:[0-9a-f-]{36}:replay$/u),
    input: z
      .unknown()
      .refine((value) => value !== undefined, 'Replay input is required'),
    deadlineAt: z.date().optional(),
    requestId: requestIdentifierSchema.optional(),
    traceId: requestIdentifierSchema.optional(),
    traceparent: traceparentSchema.optional(),
    signal: z.instanceof(AbortSignal).optional(),
    checkpointFactory: z.custom<InitialCheckpointFactory>(
      (value) => typeof value === 'function',
    ),
  })
  .strict();

export const cancelInputSchema = z
  .object({
    actorId: actorSchema,
    workspaceId: z.uuid(),
    runId: z.uuid(),
    reason: z.string().trim().min(1).max(500).optional(),
    requestId: requestIdentifierSchema.optional(),
    traceId: requestIdentifierSchema.optional(),
    traceparent: traceparentSchema.optional(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();

export const recoveryPreviewInputSchema = z
  .object({
    actorId: z.uuid(),
    workspaceId: z.uuid(),
    runId: z.uuid(),
    signal: z.instanceof(AbortSignal).optional(),
    prepareRecovery: z.custom<WorkflowRecoveryPreparation>(
      (value) => typeof value === 'function',
    ),
  })
  .strict();

export const recoveryInputSchema = replayInputSchema
  .omit({ input: true, checkpointFactory: true })
  .extend({
    scope: z.string().regex(/^workflow:[0-9a-f-]{36}:recover$/u),
    nodeRunId: z.uuid(),
    acknowledgePossibleEffects: z.literal(true).optional(),
    acknowledgeUnknownOutcome: z.literal(true).optional(),
    prepareRecovery: z.custom<WorkflowRecoveryPreparation>(
      (value) => typeof value === 'function',
    ),
  })
  .strict();
