import {
  codeDiagnosticsSchema,
  NODE_FAILURE_FIELD_LIMITS,
  type CodeDiagnostics,
  type AttemptDiagnosticFields,
  type ModelUsage,
} from '@pertexo/node-sdk';
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
          errorSummary: z
            .string()
            .min(1)
            .max(NODE_FAILURE_FIELD_LIMITS.errorSummaryCharacters)
            .parse(outcome.errorSummary),
        }),
  };
}

export function capturePreviewDiagnostics() {
  let codeDiagnostics: CodeDiagnostics | undefined;
  let modelUsage: ModelUsage | undefined;
  return {
    observeCodeDiagnostics(value: CodeDiagnostics) {
      codeDiagnostics ??= value;
    },
    observeModelUsage(value: ModelUsage) {
      modelUsage = value;
    },
    read: (): AttemptDiagnosticFields => {
      if (modelUsage !== undefined) return { modelUsage };
      return codeDiagnostics === undefined
        ? {}
        : { codeDiagnostics: codeDiagnosticsSchema.parse(codeDiagnostics) };
    },
  };
}
