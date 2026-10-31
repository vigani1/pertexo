import { z } from 'zod';
import { inspectJsonValue } from '../json/canonical.js';
import { storageTextSchema } from '../json/text.js';

export const WORKSPACE_VARIABLE_LIMITS = Object.freeze({
  count: 100,
  textCharacters: 4_096,
  bytes: 32_768,
  descriptionCharacters: 500,
  descriptionsBytes: 16_384,
});
export const workspaceVariableNameSchema = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9_]{0,63}$/u,
    'Use an uppercase letter, then uppercase letters, digits or underscores.',
  );
export const workspaceVariableValueSchema = z.union([
  storageTextSchema.max(WORKSPACE_VARIABLE_LIMITS.textCharacters),
  z.number(),
  z.boolean(),
]);
export const workspaceVariableValuesSchema = z
  .record(workspaceVariableNameSchema, workspaceVariableValueSchema)
  .superRefine((values, context) => {
    if (Object.keys(values).length > WORKSPACE_VARIABLE_LIMITS.count)
      context.addIssue({
        code: 'custom',
        message: `Keep at most ${String(WORKSPACE_VARIABLE_LIMITS.count)} workspace variables.`,
      });
    if (inspectJsonValue(values).bytes > WORKSPACE_VARIABLE_LIMITS.bytes)
      context.addIssue({
        code: 'custom',
        message: `Keep workspace variables within ${String(WORKSPACE_VARIABLE_LIMITS.bytes / 1024)} KB in total.`,
      });
  })
  .readonly();
export const workspaceVariableDescriptionsSchema = z
  .record(
    workspaceVariableNameSchema,
    storageTextSchema
      .trim()
      .max(WORKSPACE_VARIABLE_LIMITS.descriptionCharacters),
  )
  .superRefine((descriptions, context) => {
    if (Object.keys(descriptions).length > WORKSPACE_VARIABLE_LIMITS.count)
      context.addIssue({
        code: 'custom',
        message: `Keep descriptions for at most ${String(WORKSPACE_VARIABLE_LIMITS.count)} workspace variables.`,
      });
    if (
      inspectJsonValue(descriptions).bytes >
      WORKSPACE_VARIABLE_LIMITS.descriptionsBytes
    )
      context.addIssue({
        code: 'custom',
        message: `Keep variable descriptions within ${String(WORKSPACE_VARIABLE_LIMITS.descriptionsBytes / 1024)} KB in total.`,
      });
  })
  .readonly();
export const workspaceVariableSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative().max(2_147_483_647),
    values: workspaceVariableValuesSchema,
  })
  .strict()
  .readonly();
export type WorkspaceVariableValues = z.output<
  typeof workspaceVariableValuesSchema
>;
export type WorkspaceVariableSnapshot = z.output<
  typeof workspaceVariableSnapshotSchema
>;
export const EMPTY_VARIABLE_SNAPSHOT: WorkspaceVariableSnapshot = Object.freeze(
  { revision: 0, values: Object.freeze({}) },
);
