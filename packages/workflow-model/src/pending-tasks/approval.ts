import { z } from 'zod';

export const PENDING_TASK_LIMITS = Object.freeze({
  titleCharacters: 160,
  instructionsCharacters: 2_000,
  commentCharacters: 2_000,
  audienceMembers: 50,
  defaultExpirySeconds: 604_800,
  minimumExpirySeconds: 3_600,
  maximumExpirySeconds: 2_592_000,
});

export const approvalAudienceSchema = z
  .object({
    roles: z
      .array(z.enum(['owner', 'admin', 'builder', 'operator', 'viewer']))
      .max(5)
      .default(['owner', 'admin']),
    memberIds: z
      .array(z.uuid())
      .max(PENDING_TASK_LIMITS.audienceMembers)
      .default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.roles.length + value.memberIds.length === 0)
      context.addIssue({
        code: 'custom',
        message: 'Choose at least one role or member.',
      });
    if (
      new Set(value.roles).size !== value.roles.length ||
      new Set(value.memberIds).size !== value.memberIds.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Choose each role or member once.',
      });
  });

export const approvalConfigSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(PENDING_TASK_LIMITS.titleCharacters)
      .default('Approval needed'),
    instructions: z
      .string()
      .max(PENDING_TASK_LIMITS.instructionsCharacters)
      .default(''),
    expiresAfterSeconds: z
      .number()
      .int()
      .min(PENDING_TASK_LIMITS.minimumExpirySeconds)
      .max(PENDING_TASK_LIMITS.maximumExpirySeconds)
      .default(PENDING_TASK_LIMITS.defaultExpirySeconds),
    audience: approvalAudienceSchema.default({
      roles: ['owner', 'admin'],
      memberIds: [],
    }),
  })
  .strict();

export const approvalDecisionSchema = z.enum(['approved', 'rejected']);
export const approvalOutputSchema = z
  .object({
    decision: approvalDecisionSchema,
    comment: z.string().max(PENDING_TASK_LIMITS.commentCharacters).nullable(),
    decidedBy: z.uuid(),
    decidedAt: z.iso.datetime(),
  })
  .strict();

export type ApprovalConfig = z.output<typeof approvalConfigSchema>;
export type ApprovalAudience = z.output<typeof approvalAudienceSchema>;
export type ApprovalOutput = z.output<typeof approvalOutputSchema>;

export function isHumanTaskDefinition(
  definition: Readonly<{ key: string; version: number }> | undefined,
): boolean {
  return definition?.key === 'core.approval' && definition.version === 1;
}
