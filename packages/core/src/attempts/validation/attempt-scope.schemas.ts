import { UUID_PATTERN } from '@pertexo/workflow-model';
import { z } from 'zod';

// The most branch or iteration parts a stored attempt scope may hold.
const STORED_SCOPE_PARTS_MAX = 1_000;

export const identitySchema = z.string().regex(UUID_PATTERN);

const nodeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);

const branchScopePartSchema = z
  .object({
    nodeId: nodeIdSchema,
    outputPort: nodeIdSchema,
  })
  .strict();

const iterationScopePartSchema = z
  .object({
    loopNodeId: nodeIdSchema,
    ordinal: z.number().int().nonnegative(),
  })
  .strict();

export const branchContextSchema = z
  .object({
    branchPath: z
      .array(branchScopePartSchema)
      .max(STORED_SCOPE_PARTS_MAX)
      .optional(),
    iterationPath: z
      .array(iterationScopePartSchema)
      .max(STORED_SCOPE_PARTS_MAX)
      .optional(),
  })
  .strict()
  .superRefine(({ branchPath }, context) => {
    if (
      branchPath !== undefined &&
      new Set(branchPath.map(({ nodeId }) => nodeId)).size !== branchPath.length
    )
      context.addIssue({
        code: 'custom',
        message: 'branch path contains a repeated node',
      });
  });
