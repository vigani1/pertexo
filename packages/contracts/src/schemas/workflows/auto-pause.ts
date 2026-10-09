import { z } from 'zod';

import { createApiProblemSchema } from '../../errors/api-problem.js';

export const autoPauseThresholdSchema = z.number().int().min(3).max(100);
export const autoPauseSettingsRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

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

export const workflowAutoPauseSettingsSchema = z
  .object({
    enabled: z.boolean(),
    thresholdOverride: autoPauseThresholdSchema.nullable(),
    workspaceThreshold: autoPauseThresholdSchema,
    effectiveThreshold: autoPauseThresholdSchema,
    settingsRevision: autoPauseSettingsRevisionSchema,
    pauseState: z.enum(['none', 'paused']),
    pauseRevision: workflowPauseRevisionSchema,
    pausedAt: z.iso.datetime().nullable(),
    pauseReason: z.literal('consecutive_failures').nullable(),
    pausedFailures: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    pausedLastRunId: z.uuid().nullable(),
  })
  .strict();

export const workspaceAutoPauseSettingsSchema = z
  .object({
    threshold: autoPauseThresholdSchema,
    revision: autoPauseSettingsRevisionSchema,
  })
  .strict();
export const workflowAutoPauseSettingsRequestSchema = z
  .object({
    enabled: z.boolean(),
    thresholdOverride: autoPauseThresholdSchema.nullable(),
    expectedSettingsRevision: autoPauseSettingsRevisionSchema,
  })
  .strict();
export const workflowResumeRequestSchema = z
  .object({
    expectedPauseRevision: workflowPauseRevisionSchema,
  })
  .strict();
export const workspaceAutoPauseSettingsRequestSchema = z
  .object({
    threshold: autoPauseThresholdSchema,
    expectedRevision: autoPauseSettingsRevisionSchema,
  })
  .strict();
export const workflowAutoPauseCommandResponseSchema = z
  .object({
    settings: workflowAutoPauseSettingsSchema,
    replayed: z.boolean(),
  })
  .strict();
export const workspaceAutoPauseCommandResponseSchema = z
  .object({
    settings: workspaceAutoPauseSettingsSchema,
    replayed: z.boolean(),
  })
  .strict();

export const workflowPauseConflictProblemSchema = createApiProblemSchema({
  status: z.literal(409),
  code: z.literal('workflow.pause_conflict'),
  currentPauseRevision: workflowPauseRevisionSchema,
});
export const workflowAutoPauseSettingsConflictProblemSchema =
  createApiProblemSchema({
    status: z.literal(409),
    code: z.literal('workflow.auto_pause_settings_conflict'),
    currentSettingsRevision: autoPauseSettingsRevisionSchema,
  });
export const workspaceAutoPauseSettingsConflictProblemSchema =
  createApiProblemSchema({
    status: z.literal(409),
    code: z.literal('workspace.auto_pause_settings_conflict'),
    currentRevision: autoPauseSettingsRevisionSchema,
  });

export type WorkflowAutoPauseSettings = z.output<
  typeof workflowAutoPauseSettingsSchema
>;
export type WorkspaceAutoPauseSettings = z.output<
  typeof workspaceAutoPauseSettingsSchema
>;
export type WorkflowAutoPauseSettingsRequest = z.output<
  typeof workflowAutoPauseSettingsRequestSchema
>;
export type WorkflowResumeRequest = z.output<
  typeof workflowResumeRequestSchema
>;
export type WorkspaceAutoPauseSettingsRequest = z.output<
  typeof workspaceAutoPauseSettingsRequestSchema
>;
export type WorkflowAutoPauseCommandResponse = z.output<
  typeof workflowAutoPauseCommandResponseSchema
>;
export type WorkspaceAutoPauseCommandResponse = z.output<
  typeof workspaceAutoPauseCommandResponseSchema
>;
export type WorkflowPauseConflictProblem = z.output<
  typeof workflowPauseConflictProblemSchema
>;
export type WorkflowAutoPauseSettingsConflictProblem = z.output<
  typeof workflowAutoPauseSettingsConflictProblemSchema
>;
export type WorkspaceAutoPauseSettingsConflictProblem = z.output<
  typeof workspaceAutoPauseSettingsConflictProblemSchema
>;
