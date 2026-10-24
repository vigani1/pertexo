import { z } from 'zod';
import { workflowFailureClassificationSchema } from '../../flow/failure-routing/value.js';

const failedStepSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256).nullable().default(null),
    nodeType: z.string().min(1).max(256).nullable().default(null),
    errorKind: workflowFailureClassificationSchema.shape.errorKind
      .nullable()
      .default(null),
    safeErrorCode: z.string().max(128).nullable().default(null),
  })
  .strict()
  .refine(
    (value) =>
      (value.errorKind === null && value.safeErrorCode === null) ||
      workflowFailureClassificationSchema.safeParse({
        errorKind: value.errorKind,
        safeErrorCode: value.safeErrorCode,
      }).success,
    'Use an approved failure classification.',
  );

/** Application-owned metadata only; provider messages never enter this input. */
export const workflowErrorInputSchema = z
  .object({
    workflow: z
      .object({ id: z.uuid(), name: z.string().max(256), versionId: z.uuid() })
      .strict(),
    run: z
      .object({
        id: z.uuid(),
        url: z.string().regex(/^\/w\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}$/u),
        status: z.enum(['failed', 'timed_out', 'outcome_unknown']),
      })
      .strict(),
    failedStep: failedStepSchema.nullable(),
    error: z.discriminatedUnion('code', [
      z
        .object({
          code: z.literal('execution.failed'),
          message: z.literal('The workflow failed.'),
        })
        .strict(),
      z
        .object({
          code: z.literal('execution.timed_out'),
          message: z.literal('The workflow exceeded its deadline.'),
        })
        .strict(),
      z
        .object({
          code: z.literal('execution.outcome_unknown'),
          message: z.literal(
            'A step may have taken effect. Check the service before repeating it.',
          ),
        })
        .strict(),
    ]),
  })
  .strict();
export type WorkflowErrorInput = z.infer<typeof workflowErrorInputSchema>;
