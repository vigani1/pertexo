import { z } from 'zod';
import { definitionIdentitySchema } from '@pertexo/node-sdk';
import { executableNodeSchema } from '../../executable-node.js';
import { traceparentSchema } from '../../input.js';
import { sha256HexSchema } from '../../../platform/persisted-primitives.js';

const identityKeySchema = definitionIdentitySchema.shape.key;

const integrationKeySchema = z.string().regex(/^[a-z][a-z0-9._:-]*$/u);

export const inputSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual'), value: z.unknown() }).strict(),
  z
    .object({ kind: z.literal('prior_preview'), previewRunId: z.uuid() })
    .strict(),
]);

export const acceptPreviewRunInputSchema = z
  .object({
    actorUserId: z.uuid(),
    definitionKey: identityKeySchema,
    definitionVersion: z.number().int().positive(),
    draftFingerprint: sha256HexSchema,
    draftRevision: z.number().int().positive(),
    expectedSampleId: z.uuid().nullable().optional(),
    dryRun: z.enum(['not_supported', 'provider_supported']),
    executableNode: executableNodeSchema,
    executorKey: identityKeySchema,
    executorVersion: z.number().int().positive(),
    executionDeadlineAt: z.date(),
    expiresAt: z.date(),
    input: inputSourceSchema,
    keyHash: sha256HexSchema,
    mayContactProvider: z.boolean(),
    mayCauseExternalSideEffect: z.boolean(),
    nodeId: z.string().min(1).max(256),
    operation: z.literal('preview.execute'),
    operationKey: integrationKeySchema.max(128).optional(),
    providerKey: integrationKeySchema.max(64).optional(),
    providerIdempotencyKey: z.string().min(1).max(256).optional(),
    requestHash: sha256HexSchema,
    requestId: z.string().min(1).max(128).optional(),
    scope: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    sideEffectClass: z.enum(['safe', 'idempotent_with_key', 'unsafe']),
    traceId: z.string().min(1).max(128).optional(),
    traceparent: traceparentSchema,
    workflowId: z.uuid(),
  })
  .strict()
  .refine(
    (input) =>
      input.sideEffectClass !== 'idempotent_with_key' ||
      input.providerIdempotencyKey !== undefined,
    'idempotent execution requires a provider idempotency key',
  )
  .refine(
    (input) =>
      (input.providerKey === undefined) === (input.operationKey === undefined),
    'provider and operation classification must be supplied together',
  );

export const resultRefSchema = z.union([
  z.object({ outboxEventId: z.uuid(), previewAttemptId: z.uuid() }).strict(),
  z.object({ pinnedSampleId: z.uuid() }).strict(),
]);
