import {
  boundedNodeJsonSchema,
  CODE_LIMITS,
  inspectCodeSource,
} from '@pertexo/node-sdk';
import { z } from 'zod';
export const CORE_CODE_CONFIG_SCHEMA = z
  .object({
    code: z
      .string()
      .max(CODE_LIMITS.sourceBytes)
      .superRefine((source, context) => {
        const issue = inspectCodeSource(source);
        if (issue !== undefined)
          context.addIssue({
            code: 'custom',
            message: `${issue.message} Line ${String(issue.line)}, column ${String(issue.column)}.`,
          });
      }),
    timeoutSeconds: z.number().int().min(1).max(300).optional(),
  })
  .strict();
export const CORE_CODE_INPUT_SCHEMA = boundedNodeJsonSchema;
export const CORE_CODE_OUTPUT_SCHEMA = boundedNodeJsonSchema;
export type CoreCodeConfig = z.output<typeof CORE_CODE_CONFIG_SCHEMA>;
