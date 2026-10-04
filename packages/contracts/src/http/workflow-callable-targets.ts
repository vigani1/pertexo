import { z } from 'zod';
import { callableObjectTypeDescriptorSchemaV1 } from '@pertexo/workflow-model/callable-type-contract';
import { workflowCallPinSchemaV1 } from '@pertexo/workflow-model/workflow-call-contract';
import { createApiProblemSchema } from '../errors/api-problem.js';

/** Separate opt-in grammar; neither branch accepts repeated or unknown fields. */
export const workflowCallableTargetsQuerySchema = z.union([
  z
    .object({
      include: z.literal('callableTarget'),
      limit: z
        .union([z.string().regex(/^[0-9]+$/u), z.number()])
        .pipe(z.coerce.number<string | number>().int().min(1).max(25))
        .default(1),
      after: z.string().min(1).max(512).optional(),
    })
    .strict(),
  z
    .object({
      include: z.literal('callableTarget'),
      versionId: z.uuid(),
    })
    .strict(),
]);

export const workflowCallableTargetEligibilitySchema = z.discriminatedUnion(
  'status',
  [
    z.object({ status: z.literal('eligible') }).strict(),
    z
      .object({
        status: z.literal('ineligible'),
        reason: z.enum([
          'not_native_executable',
          'not_callable',
          'workflow_inactive',
          'current_compatibility_denied',
          'dependency_ineligible',
        ]),
      })
      .strict(),
    z
      .object({
        status: z.literal('unavailable'),
        reason: z.enum([
          'native_authoring_unavailable',
          'compatibility_support_unavailable',
          'dependency_assessment_unavailable',
        ]),
      })
      .strict(),
  ],
);

/** Descriptors only: no selector, graph, result value or new identity authority. */
export const workflowCallableTargetContractSchema = z
  .object({
    input: callableObjectTypeDescriptorSchemaV1,
    result: callableObjectTypeDescriptorSchemaV1,
  })
  .strict();

const verifiedTargetSchema = z
  .object({
    pin: workflowCallPinSchemaV1,
    contract: workflowCallableTargetContractSchema,
    eligibility: workflowCallableTargetEligibilitySchema,
  })
  .strict();
const unverifiedTargetSchema = z
  .object({
    pin: z.null(),
    contract: z.null(),
    eligibility: z.discriminatedUnion('status', [
      workflowCallableTargetEligibilitySchema.options[1],
      workflowCallableTargetEligibilitySchema.options[2],
    ]),
  })
  .strict();

export const workflowCallableTargetVersionSchema = z
  .object({
    id: z.uuid(),
    workflowId: z.uuid(),
    versionNumber: z.number().int().positive(),
    publishedAt: z.iso.datetime(),
    callableTarget: z.union([verifiedTargetSchema, unverifiedTargetSchema]),
  })
  .strict()
  .superRefine((version, context) => {
    const pin = version.callableTarget.pin;
    if (
      pin !== null &&
      (pin.versionId !== version.id || pin.workflowId !== version.workflowId)
    )
      context.addIssue({
        code: 'custom',
        path: ['callableTarget', 'pin'],
        message: 'Callable pin must match the exact version and workflow.',
      });
  });

export const workflowCallableTargetsResponseSchema = z
  .object({
    projection: z.literal('callableTarget'),
    workspaceId: z.uuid(),
    permissions: z
      .object({ canEditDraft: z.boolean(), canUseInPublication: z.boolean() })
      .strict(),
    items: z.array(workflowCallableTargetVersionSchema).max(25),
    nextCursor: z.string().min(1).max(512).nullable(),
  })
  .strict();

/** Safe whole-request refusals, not per-target eligibility or runtime readiness. */
export const workflowCallableTargetsUnavailableProblemSchema =
  createApiProblemSchema({
    status: z.literal(503),
    code: z.literal('workflow.callable_targets_unavailable'),
  });

export type WorkflowCallableTargetsQuery = z.output<
  typeof workflowCallableTargetsQuerySchema
>;
export type WorkflowCallableTargetsResponse = z.output<
  typeof workflowCallableTargetsResponseSchema
>;
export type WorkflowCallableTargetVersion = z.output<
  typeof workflowCallableTargetVersionSchema
>;
export type WorkflowCallableTargetEligibility = z.output<
  typeof workflowCallableTargetEligibilitySchema
>;
export type WorkflowCallableTargetContract = z.output<
  typeof workflowCallableTargetContractSchema
>;
