import { z } from 'zod';
export const observeBacklogInputSchema = z.object({
  enabledJobNames: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,127}$/u))
    .max(64)
    .refine((values) => new Set(values).size === values.length),
});

export const leasedEventSchema = z.object({
  id: z.uuid(),
  leaseToken: z.uuid(),
});

export const releaseInputSchema = leasedEventSchema.extend({
  errorCode: z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u),
  maxAttempts: z.number().int().min(1).max(1_000),
  retryAt: z.date(),
});
