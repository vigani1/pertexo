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

export const claimInputSchema = z.object({
  enabledJobNames: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,127}$/u))
    .max(64)
    .refine((values) => new Set(values).size === values.length),
  leaseDurationMillis: z.number().int().min(1_000).max(300_000),
  leaseOwner: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
  leaseToken: z.uuid(),
  limit: z.number().int().min(1).max(100),
  maxAttempts: z.number().int().min(1).max(1_000),
});
