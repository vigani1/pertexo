import { ADMINISTRATIVE_ROLES } from '../../workspaces/policy.js';
import { z } from 'zod';
import { storageTextSchema } from '../../values/json/text.js';
import { PENDING_TASK_LIMITS, taskAudienceSchema } from './audience.js';

/** What happens when nobody responds before the task expires. */
export const taskExpiryChoiceSchema = z.enum(['fail', 'continue']);
export type TaskExpiryChoice = z.output<typeof taskExpiryChoiceSchema>;

/** A task setup's expiry choice; one saved without it fails the step. */
export function taskExpiryChoice(
  setup: Readonly<{ onExpiry?: TaskExpiryChoice | undefined }>,
): TaskExpiryChoice {
  return setup.onExpiry ?? 'fail';
}

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
    // Absent means fail, as in every step saved before the Timed out path
    // existed. No default: a stored setup must parse to itself.
    onExpiry: taskExpiryChoiceSchema.exactOptional(),
    allowStarterToDecide: z.boolean().exactOptional(),
    audience: taskAudienceSchema.default({
      roles: [...ADMINISTRATIVE_ROLES],
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
    decidedByName: storageTextSchema.max(256).optional(),
    decidedAt: z.iso.datetime(),
  })
  .strict();

export type ApprovalConfig = z.output<typeof approvalConfigSchema>;
export type ApprovalOutput = z.output<typeof approvalOutputSchema>;

export function isHumanTaskDefinition(
  definition: Readonly<{ key: string; version: number }> | undefined,
): boolean {
  return (
    definition !== undefined &&
    ['core.approval', 'core.request_input'].includes(definition.key) &&
    definition.version === 1
  );
}
