import type { z } from 'zod';
import { PENDING_TASK_LIMITS, storedTaskBytes } from './audience.js';
import { formConfigSchema } from '../../triggers/forms/fields.js';
import { approvalConfigSchema } from './approval.js';
import { formatByteSize } from '@pertexo/node-sdk';

export const inputRequestConfigSchema = formConfigSchema
  .omit({ thankYouMessage: true, redirectUrl: true })
  .extend({
    title: formConfigSchema.shape.title.default('Input needed'),
    audience: approvalConfigSchema.shape.audience,
    expiresAfterSeconds: approvalConfigSchema.shape.expiresAfterSeconds,
    onExpiry: approvalConfigSchema.shape.onExpiry,
  })
  .strict()
  .refine(
    (value) => storedTaskBytes(value) <= PENDING_TASK_LIMITS.configBytes,
    `Keep the task setup within ${formatByteSize(PENDING_TASK_LIMITS.configBytes)}; shorten instructions, help text or options.`,
  );
export type InputRequestConfig = z.output<typeof inputRequestConfigSchema>;
