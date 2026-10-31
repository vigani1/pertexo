import { z } from 'zod';
import {
  workspaceVariableValuesSchema,
  workspaceVariableDescriptionsSchema,
  workspaceVariableSnapshotSchema,
  workspaceVariableNameSchema,
} from '@pertexo/workflow-model';
export const workspaceVariablesResponseSchema = workspaceVariableSnapshotSchema
  .unwrap()
  .extend({ descriptions: workspaceVariableDescriptionsSchema.default({}) })
  .strict()
  .readonly();
export const workspaceVariablesRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative().max(2_147_483_646),
    values: workspaceVariableValuesSchema,
    descriptions: workspaceVariableDescriptionsSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    for (const name of Object.keys(input.descriptions ?? {}))
      if (!Object.hasOwn(input.values, name))
        context.addIssue({
          code: 'custom',
          path: ['descriptions', name],
          message: 'A description must belong to a configured variable.',
        });
  });
export const workspaceVariablesCommandResponseSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    changed: z.boolean(),
    replayed: z.boolean(),
  })
  .strict();
export const workspaceVariableUsageQuerySchema = z
  .object({
    name: workspaceVariableNameSchema,
    after: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/u)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export const workspaceVariableUsageCursorSchema = z
  .object({
    workflowId: z.uuid(),
    offset: z.number().int().nonnegative().max(100_000),
    stamp: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
export const workspaceVariableUsageResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().regex(/^[0-9a-f]{64}$/u),
            workflowId: z.uuid(),
            workflowName: z.string().max(160),
            archived: z.boolean(),
            stage: z.enum(['draft', 'published']),
            nodeId: z.string().max(128).nullable(),
            label: z.string().max(160),
            input: z.string().max(128),
            kind: z.enum(['direct', 'dynamic']),
          })
          .strict(),
      )
      .max(100),
    nextCursor: z.string().max(1024).nullable(),
    incomplete: z.boolean(),
    checkedWorkflows: z.number().int().nonnegative(),
    totalWorkflows: z.number().int().nonnegative(),
  })
  .strict();
export const workflowRunVariablesResponseSchema = z
  .object({ snapshot: workspaceVariableSnapshotSchema.nullable() })
  .strict();
export type WorkspaceVariablesRequest = z.output<
  typeof workspaceVariablesRequestSchema
>;
export type WorkspaceVariablesResponse = z.output<
  typeof workspaceVariablesResponseSchema
>;
export type WorkspaceVariablesCommandResponse = z.output<
  typeof workspaceVariablesCommandResponseSchema
>;
export type WorkspaceVariableUsageCursor = z.output<
  typeof workspaceVariableUsageCursorSchema
>;
export type WorkspaceVariableUsageResponse = z.output<
  typeof workspaceVariableUsageResponseSchema
>;
export type WorkflowRunVariablesResponse = z.output<
  typeof workflowRunVariablesResponseSchema
>;
