import {
  MAX_AUTO_PAUSE_THRESHOLD,
  MIN_AUTO_PAUSE_THRESHOLD,
} from '@pertexo/policy';
import {
  STORED_INTEGER_MAX,
  STORED_TIMESTAMP_FRACTION_DIGITS,
} from '@pertexo/workflow-model';
import { z } from 'zod';

const revision = z.number().int().positive().max(STORED_INTEGER_MAX);

const pauseRevision = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);

const threshold = z
  .number()
  .int()
  .min(MIN_AUTO_PAUSE_THRESHOLD)
  .max(MAX_AUTO_PAUSE_THRESHOLD);

/** What an exact retry replays; a settings command writes these whole. */
export const workflowSettings = z
  .object({
    enabled: z.boolean(),
    thresholdOverride: threshold.nullable(),
    workspaceThreshold: threshold,
    effectiveThreshold: threshold,
    settingsRevision: revision,
    pauseState: z.enum(['none', 'paused']),
    pauseRevision,
    pausedAt: z.iso
      .datetime({ precision: STORED_TIMESTAMP_FRACTION_DIGITS })
      .nullable(),
    pauseReason: z.literal('consecutive_failures').nullable(),
    pausedFailures: z.number().int().positive().nullable(),
    pausedLastRunId: z.uuid().nullable(),
  })
  .strict();

export const workspaceSettings = z.object({ threshold, revision }).strict();
