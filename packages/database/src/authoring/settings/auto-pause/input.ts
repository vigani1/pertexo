import { z } from 'zod';

export const revision = z.number().int().positive().max(2_147_483_647);

export const pauseRevision = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);

export const threshold = z.number().int().min(3).max(100);

export const workflowSettings = z
  .object({
    enabled: z.boolean(),
    thresholdOverride: threshold.nullable(),
    workspaceThreshold: threshold,
    effectiveThreshold: threshold,
    settingsRevision: revision,
    pauseState: z.enum(['none', 'paused']),
    pauseRevision,
    pausedAt: z.iso.datetime({ precision: 6 }).nullable(),
    pauseReason: z.literal('consecutive_failures').nullable(),
    pausedFailures: z.number().int().positive().nullable(),
    pausedLastRunId: z.uuid().nullable(),
  })
  .strict();

export const workspaceSettings = z.object({ threshold, revision }).strict();
