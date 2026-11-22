import { z } from 'zod';
import {
  guardrailsDiagnosticsSchema,
  type GuardrailsDiagnostics,
} from './guardrails-diagnostics.js';
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
    kind: z.literal('guardrails'),
    reasons: guardrailsDiagnosticsSchema,
  }),
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
      guardrailsDiagnostics?: never;
    }>
  | Readonly<{
      codeDiagnostics?: never;
      modelUsage: ModelUsage;
      guardrailsDiagnostics?: never;
    }>
  | Readonly<{
      codeDiagnostics?: never;
      modelUsage?: never;
      guardrailsDiagnostics: GuardrailsDiagnostics;
    }>;

export function storedAttemptDiagnostics({
  codeDiagnostics,
  modelUsage,
  guardrailsDiagnostics,
}: AttemptDiagnosticFields): AttemptDiagnostics | null {
  if (guardrailsDiagnostics !== undefined)
    return { kind: 'guardrails', reasons: guardrailsDiagnostics };
  return modelUsage === undefined
    ? (codeDiagnostics ?? null)
    : { kind: 'model_usage', modelUsage };
}

export function attemptDiagnosticFields(
  value: AttemptDiagnostics | null,
): AttemptDiagnosticFields {
  if (value === null) return {};
  if (!('kind' in value)) return { codeDiagnostics: value };
  return value.kind === 'guardrails'
    ? { guardrailsDiagnostics: value.reasons }
    : { modelUsage: value.modelUsage };
}
