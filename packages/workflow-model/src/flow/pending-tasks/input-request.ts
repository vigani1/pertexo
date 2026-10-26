import type { z } from 'zod';
import { inspectJsonValue } from '../../values/json/canonical.js';
import { PENDING_TASK_LIMITS } from './audience.js';
import { formConfigSchema } from '../../triggers/forms/fields.js';
import { approvalConfigSchema } from './approval.js';

export const inputRequestConfigSchema = formConfigSchema
  .omit({ thankYouMessage: true, redirectUrl: true })
  .extend({
    title: formConfigSchema.shape.title.default('Input needed'),
    audience: approvalConfigSchema.shape.audience,
    expiresAfterSeconds: approvalConfigSchema.shape.expiresAfterSeconds,
    onExpiry: approvalConfigSchema.shape.onExpiry,
  })
  .strict()
  .refine((value) => {
    const { bytes, members } = inspectJsonValue(value);
    // PostgreSQL jsonb inserts spaces after separators in its text fence.
    return bytes + 2 * members <= PENDING_TASK_LIMITS.configBytes;
  }, 'Keep the task setup within 16 KB; shorten instructions, help text or options.');
export type InputRequestConfig = z.output<typeof inputRequestConfigSchema>;
