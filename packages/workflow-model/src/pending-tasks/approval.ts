import { z } from 'zod';
import { PENDING_TASK_LIMITS, taskAudienceSchema } from './audience.js';

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
    audience: taskAudienceSchema.default({
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
export type ApprovalOutput = z.output<typeof approvalOutputSchema>;

export function isHumanTaskDefinition(
  definition: Readonly<{ key: string; version: number }> | undefined,
): boolean {
  return definition?.key === 'core.approval' && definition.version === 1;
}
