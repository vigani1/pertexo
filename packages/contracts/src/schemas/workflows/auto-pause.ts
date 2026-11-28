import { responseSchema } from '../shared/response-schema.js';
import { z } from 'zod';
import {
  autoPauseThresholdSchema,
  triggerPauseSnapshotSchema,
  workflowPauseRevisionSchema,
} from '@pertexo/workflow-model';

import { createApiProblemSchema } from '../../errors/api-problem.js';

export { autoPauseThresholdSchema, workflowPauseRevisionSchema };
export const autoPauseSettingsRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const workflowAutoPauseSettingsSchema = responseSchema(
  triggerPauseSnapshotSchema(autoPauseSettingsRevisionSchema),
);

export const workspaceAutoPauseSettingsSchema = responseSchema(
  z
    .object({
      threshold: autoPauseThresholdSchema,
      revision: autoPauseSettingsRevisionSchema,
    })
    .strict(),
);
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
export const workflowAutoPauseCommandResponseSchema = responseSchema(
  z
    .object({
      settings: workflowAutoPauseSettingsSchema,
      replayed: z.boolean(),
    })
    .strict(),
);
export const workspaceAutoPauseCommandResponseSchema = responseSchema(
  z
    .object({
      settings: workspaceAutoPauseSettingsSchema,
      replayed: z.boolean(),
    })
    .strict(),
);

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
export type WorkflowPauseConflictProblem = z.output<
  typeof workflowPauseConflictProblemSchema
>;
export type WorkflowAutoPauseSettingsConflictProblem = z.output<
  typeof workflowAutoPauseSettingsConflictProblemSchema
>;
export type WorkspaceAutoPauseSettingsConflictProblem = z.output<
  typeof workspaceAutoPauseSettingsConflictProblemSchema
>;
