import { z } from 'zod';
import {
  boundedNodeJsonSchema,
  boundedNodeJsonRecordSchema,
} from '../definitions/catalog.js';
import type { JsonValue } from '../execution/contract.js';
import { CODE_LIMITS, codeSettingsSchema } from './limits.js';

export const CODE_ERROR_CODES = Object.freeze([
  'code.syntax_error',
  'code.runtime_error',
  'code.timeout',
  'code.memory_limit',
  'code.output_invalid',
  'code.module_refused',
  'code.disabled',
  'code.runner_unavailable',
] as const);
export const codeErrorCodeSchema = z.enum(CODE_ERROR_CODES);
export type CodeErrorCode = z.output<typeof codeErrorCodeSchema>;
export const codeDiagnosticsSchema = z
  .object({
    logs: z
      .array(
        z
          .object({
            level: z.enum(['log', 'info', 'warn', 'error', 'debug']),
            message: z.string().max(CODE_LIMITS.logLineCharacters),
          })
          .strict(),
      )
      .max(CODE_LIMITS.logLines),
    truncated: z.boolean(),
    error: z
      .object({
        message: z.string().max(CODE_LIMITS.messageCharacters),
        line: z.number().int().positive().optional(),
        column: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const bytes = value.logs.reduce(
      (sum, line) => sum + new TextEncoder().encode(line.message).byteLength,
      0,
    );
    if (bytes > CODE_LIMITS.logBytes)
      context.addIssue({
        code: 'custom',
        message: 'Code logs exceed their byte budget',
      });
  });
export type CodeDiagnostics = Readonly<z.output<typeof codeDiagnosticsSchema>>;
export const codeTaskSchema = z
  .object({
    code: z
      .string()
      .max(CODE_LIMITS.sourceBytes)
      .refine(
        (value) =>
          new TextEncoder().encode(value).byteLength <= CODE_LIMITS.sourceBytes,
      ),
    timeoutSeconds: z.number().int().min(1).max(300),
    input: boundedNodeJsonSchema,
    variables: boundedNodeJsonRecordSchema,
  })
  .strict();
export type CodeTask = Readonly<z.output<typeof codeTaskSchema>>;
export const codeResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('succeeded'),
      output: boundedNodeJsonSchema,
      diagnostics: codeDiagnosticsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('failed'),
      code: codeErrorCodeSchema,
      diagnostics: codeDiagnosticsSchema,
    })
    .strict(),
]);
export type CodeResult = z.output<typeof codeResultSchema>;
export const codeGreetingSchema = z
  .object({
    kind: z.enum(['ready', 'busy']),
    mode: z.enum(['hardened', 'process']),
    settings: codeSettingsSchema,
  })
  .strict();
export type CodeGreeting = z.output<typeof codeGreetingSchema>;
export interface NodeCodeRuntime {
  execute(
    input: Readonly<{
      code: string;
      timeoutSeconds?: number;
      input: JsonValue;
      signal: AbortSignal;
    }>,
  ): Promise<CodeResult>;
}
