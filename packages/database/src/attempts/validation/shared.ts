import { UUID_PATTERN } from '@pertexo/workflow-model';
import { z } from 'zod';

import { sha256HexSchema } from '../../platform/persisted-primitives.js';

export const identitySchema = z.string().regex(UUID_PATTERN);

const checksumSchema = sha256HexSchema;

export const workerIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u);

export const deliverySchema = z
  .object({
    outboxEventId: identitySchema,
    payloadChecksum: checksumSchema,
  })
  .strict();

export const nodeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);

export const invocationKeySchema = z.string().min(1).max(256);

export const NODE_ATTEMPT_INPUT_LIMITS = Object.freeze({
  upstreamNodeOutputs: 100,
});

export const sideEffectClassSchema = z.enum([
  'safe',
  'idempotent_with_key',
  'unsafe',
]);

export const admissionKindSchema = z.enum(['execute', 'retry', 'wait_resume']);

export const branchScopePartSchema = z
  .object({
    nodeId: nodeIdSchema,
    outputPort: nodeIdSchema,
  })
  .strict();

export const iterationScopePartSchema = z
  .object({
    loopNodeId: nodeIdSchema,
    ordinal: z.number().int().nonnegative(),
  })
  .strict();

export const branchContextSchema = z
  .object({
    branchPath: z.array(branchScopePartSchema).max(1_000).optional(),
    iterationPath: z.array(iterationScopePartSchema).max(1_000).optional(),
  })
  .strict()
  .superRefine(({ branchPath }, context) => {
    if (
      branchPath !== undefined &&
      new Set(branchPath.map(({ nodeId }) => nodeId)).size !== branchPath.length
    )
      context.addIssue({
        code: 'custom',
        message: 'branch path contains a repeated node',
      });
  });

export const providerDispatchBindingSchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9._-]{0,31}:sha256:[0-9a-f]{64}$/u);

export const connectionDispatchFenceSchema = z
  .object({
    connectionId: z.uuid(),
    expectedProviderKey: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/u),
    expectedAuthType: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/u),
    secretVersionId: z.uuid(),
  })
  .strict();
