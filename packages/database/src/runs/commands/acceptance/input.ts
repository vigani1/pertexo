import { z } from 'zod';
import type { RunInputValidator } from '../initial-checkpoint.js';
import { sha256HexSchema as sha256Schema } from '../../../platform/persisted-primitives.js';

const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16))
  .optional();

export const acceptWorkflowRunInputSchema = z
  .object({
    initialCheckpoint: z.unknown(),
    validateInput: z
      .custom<RunInputValidator>((value) => typeof value === 'function')
      .optional(),
    deadlineAt: z.date().optional(),
    absoluteDeadlineAt: z.date().nullable().optional(),
    startedBy: z.uuid().optional(),
    keyHash: sha256Schema,
    operation: z.literal('workflow.run.accept'),
    requestHash: sha256Schema,
    replayCommandId: z.uuid().optional(),
    replaySourceRunId: z.uuid().optional(),
    runInput: z.unknown().optional(),
    scope: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    traceparent: traceparentSchema,
    triggerType: z.enum([
      'test',
      'api',
      'manual',
      'replay',
      'schedule',
      'webhook',
      'workflow_call',
      'workflow_error',
      'form',
    ]),
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
  })
  .strict();

export const acceptanceReplayInputSchema = acceptWorkflowRunInputSchema.pick({
  keyHash: true,
  operation: true,
  requestHash: true,
  scope: true,
});
