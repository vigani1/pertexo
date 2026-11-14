import { ROLES, ADMINISTRATIVE_ROLES } from '@pertexo/policy';
import { z } from 'zod';
import { PENDING_TASK_LIMITS } from './pending-task-limits.js';

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
