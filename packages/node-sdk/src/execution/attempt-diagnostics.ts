import { z } from 'zod';
import { codeDiagnosticsSchema } from '../code/code-protocol.schemas.js';

export const MODEL_IDENTIFIER_MAX_CHARACTERS = 512;
export const attemptTokenCountSchema = z.int().nonnegative();
const model = z.string().min(1).max(MODEL_IDENTIFIER_MAX_CHARACTERS);

export const modelUsageSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('complete'),
    model,
    inputTokens: attemptTokenCountSchema,
    outputTokens: attemptTokenCountSchema,
  }),
  z.strictObject({
    kind: z.literal('incomplete'),
    model,
    inputTokens: attemptTokenCountSchema.nullable(),
    outputTokens: attemptTokenCountSchema.nullable(),
  }),
]);
export type ModelUsage = Readonly<z.output<typeof modelUsageSchema>>;

export const attemptDiagnosticsSchema = z.union([
  codeDiagnosticsSchema,
  z.strictObject({
    kind: z.literal('model_usage'),
    modelUsage: modelUsageSchema,
  }),
]);
export type AttemptDiagnostics = Readonly<
  z.output<typeof attemptDiagnosticsSchema>
>;

export type AttemptDiagnosticFields =
  | Readonly<{
      codeDiagnostics?: z.output<typeof codeDiagnosticsSchema>;
      modelUsage?: never;
    }>
  | Readonly<{ codeDiagnostics?: never; modelUsage: ModelUsage }>;

export function storedAttemptDiagnostics({
  codeDiagnostics,
  modelUsage,
}: AttemptDiagnosticFields): AttemptDiagnostics | null {
  return modelUsage === undefined
    ? (codeDiagnostics ?? null)
    : { kind: 'model_usage', modelUsage };
}

export function attemptDiagnosticFields(
  value: AttemptDiagnostics | null,
): AttemptDiagnosticFields {
  if (value === null) return {};
  return 'kind' in value
    ? { modelUsage: value.modelUsage }
    : { codeDiagnostics: value };
}
