import { codeDiagnosticsSchema, type CodeDiagnostics } from '@pertexo/node-sdk';
import { z } from 'zod';
import type { PreviewTerminalOutcome } from '@pertexo/core/previews';

type PreviewFailure = Exclude<
  PreviewTerminalOutcome,
  { readonly status: 'succeeded' }
>;

/** Executor-owned failure details enter the durable preview contract here. */
export function parsePreviewFailure(outcome: PreviewFailure): PreviewFailure {
  return {
    ...outcome,
    safeErrorCode: z
      .string()
      .regex(/^[a-z][a-z0-9._:-]{0,127}$/u)
      .parse(outcome.safeErrorCode),
    ...(outcome.errorSummary === undefined
      ? {}
      : {
          errorSummary: z.string().min(1).max(2048).parse(outcome.errorSummary),
        }),
  };
}

export function previewDiagnostics(value: CodeDiagnostics | undefined): {
  codeDiagnostics?: CodeDiagnostics;
} {
  return value === undefined
    ? {}
    : { codeDiagnostics: codeDiagnosticsSchema.parse(value) };
}
