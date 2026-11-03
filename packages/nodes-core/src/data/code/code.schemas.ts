import {
  boundedNodeJsonSchema,
  CODE_LIMITS,
  inspectCodeSource,
  codeLanguageSchema,
} from '@pertexo/node-sdk';
import { z } from 'zod';
export const CORE_CODE_CONFIG_SCHEMA = z
  .object({
    language: codeLanguageSchema.optional(),
    code: z.string().max(CODE_LIMITS.sourceBytes),
    timeoutSeconds: z.number().int().min(1).max(300).optional(),
  })
  .strict()
  .superRefine((config, context) => {
    const issue = inspectCodeSource(config.code, config.language);
    if (issue !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['code'],
        message: `${issue.message} Line ${String(issue.line)}, column ${String(issue.column)}.`,
      });
  });
export const CORE_CODE_INPUT_SCHEMA = boundedNodeJsonSchema;
export const CORE_CODE_OUTPUT_SCHEMA = boundedNodeJsonSchema;
export type CoreCodeConfig = z.output<typeof CORE_CODE_CONFIG_SCHEMA>;
