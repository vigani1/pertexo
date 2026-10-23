import { ROLES, ADMINISTRATIVE_ROLES } from '../../workspaces/policy.js';
import { z } from 'zod';

export const PENDING_TASK_LIMITS = Object.freeze({
  titleCharacters: 160,
  configBytes: 16_384,
  instructionsCharacters: 2_000,
  commentCharacters: 2_000,
  audienceMembers: 50,
  defaultExpirySeconds: 604_800,
  minimumExpirySeconds: 3_600,
  maximumExpirySeconds: 2_592_000,
});

export const taskAudienceSchema = z
  .object({
    roles: z
      .array(z.enum(ROLES))
      .max(ROLES.length)
      .default([...ADMINISTRATIVE_ROLES]),
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

export type TaskAudience = z.output<typeof taskAudienceSchema>;
