import { z } from 'zod';
import {
  MAX_AUTO_PAUSE_THRESHOLD,
  MIN_AUTO_PAUSE_THRESHOLD,
} from '@pertexo/policy';
import {
  pollPauseEvidenceSchema,
  runPauseEvidenceSchema,
} from './pause-evidence.js';

export const autoPauseThresholdSchema = z
  .number()
  .int()
  .min(MIN_AUTO_PAUSE_THRESHOLD)
  .max(MAX_AUTO_PAUSE_THRESHOLD);

// A decimal string retains PostgreSQL bigint precision in JSON. Encode the
// upper bound in the regex as well, so generated clients enforce the same limit.
const maxPauseRevision = '9223372036854775807';
const boundedPrefixes = Array.from(maxPauseRevision).flatMap((digit, index) => {
  const lower = index === 0 ? 1 : 0;
  const upper = Number(digit) - 1;
  if (upper < lower) return [];
  const range = `[${String(lower)}-${String(upper)}]`;
  const remaining = maxPauseRevision.length - index - 1;
  return [
    `${maxPauseRevision.slice(0, index)}${range}${remaining === 0 ? '' : `[0-9]{${String(remaining)}}`}`,
  ];
});
export const workflowPauseRevisionSchema = z
  .string()
  .regex(
    new RegExp(
      `^(?:[1-9][0-9]{0,17}|${boundedPrefixes.join('|')}|${maxPauseRevision})$`,
      'u',
    ),
  );

/** Receipts and API responses share pause states, with their own revision bounds. */
export function triggerPauseSnapshotSchema(
  settingsRevision: z.ZodNumber,
  timestamp = z.iso.datetime(),
) {
  const settings = {
    enabled: z.boolean(),
    thresholdOverride: autoPauseThresholdSchema.nullable(),
    workspaceThreshold: autoPauseThresholdSchema,
    effectiveThreshold: autoPauseThresholdSchema,
    settingsRevision,
    pauseRevision: workflowPauseRevisionSchema,
  };
  const unpaused = z.strictObject({
    ...settings,
    pauseState: z.literal('none'),
    pauseReason: z.null(),
    pausedAt: z.null(),
    pausedBy: z.never().optional(),
    pausedFailures: z.null(),
    pausedLastRunId: z.null(),
    pauseEvidence: z.never().optional(),
  });
  const manual = z.strictObject({
    ...settings,
    pauseState: z.literal('paused'),
    pauseReason: z.literal('manual'),
    pausedAt: timestamp,
    pausedBy: z.strictObject({
      id: z.uuid(),
      displayName: z.string().nullable(),
    }),
    pausedFailures: z.null(),
    pausedLastRunId: z.null(),
    pauseEvidence: z.never().optional(),
  });
  const automatic = {
    ...settings,
    pauseState: z.literal('paused'),
    pauseReason: z.literal('consecutive_failures'),
    pausedAt: timestamp,
    pausedBy: z.never().optional(),
    pausedFailures: z.number().int().positive(),
  };
  const run = z
    .strictObject({
      ...automatic,
      pausedLastRunId: z
        .uuid()
        .describe(
          'Run that triggered the pause: the last counted failed triggered run; older rows hold the run that reached the failure threshold.',
        ),
      pauseEvidence: runPauseEvidenceSchema
        .optional()
        .describe('Completed-run responses may carry only pausedLastRunId.'),
    })
    .refine(
      ({ pauseEvidence, pausedLastRunId }) =>
        pauseEvidence === undefined || pauseEvidence.runId === pausedLastRunId,
      'The run evidence must match pausedLastRunId.',
    );
  const poll = z.strictObject({
    ...automatic,
    pausedLastRunId: z.null(),
    pauseEvidence: pollPauseEvidenceSchema,
  });
  return z.union([unpaused, manual, run, poll]);
}
