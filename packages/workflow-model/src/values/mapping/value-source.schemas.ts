import { z } from 'zod';

export const runInputValueSourceSchema = z
  .object({ kind: z.literal('run_input'), path: z.string() })
  .strict();
export const expressionValueSourceSchema = z
  .object({
    kind: z.literal('expression'),
    language: z.literal('jsonata'),
    expression: z.string(),
  })
  .strict();
