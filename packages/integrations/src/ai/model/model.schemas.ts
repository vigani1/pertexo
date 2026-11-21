import { boundedNodeJsonRecordSchema, labelledChoice } from '@pertexo/node-sdk';
import { z } from 'zod';
import { compileModelOutputSchema } from './output-schema.js';

export const MODEL_LIMITS = {
  modelCharacters: 512,
  requestBytes: 64 * 1_024,
  responseBytes: 128 * 1_024,
  defaultOutputTokens: 1_024,
  maxOutputTokens: 4_096,
  defaultTimeoutMillis: 30_000,
  maxTimeoutMillis: 60_000,
} as const;

const modeLabels = {
  text: 'Generate text',
  structured: 'Extract structured data',
} as const;
const modes = labelledChoice(modeLabels);
const mode = <Mode extends keyof typeof modeLabels>(value: Mode) =>
  modes.extract([value]).meta({ const: value, title: modeLabels[value] });
const common = {
  model: z
    .string()
    .min(1)
    .max(MODEL_LIMITS.modelCharacters)
    .refine((value) => value.trim() !== '')
    .meta({ title: 'Model identifier' }),
  timeoutMillis: z
    .number()
    .int()
    .positive()
    .max(MODEL_LIMITS.maxTimeoutMillis)
    .optional()
    .meta({ title: 'Timeout', default: MODEL_LIMITS.defaultTimeoutMillis }),
  maxOutputTokens: z
    .number()
    .int()
    .positive()
    .max(MODEL_LIMITS.maxOutputTokens)
    .optional()
    .meta({
      title: 'Maximum output tokens',
      default: MODEL_LIMITS.defaultOutputTokens,
    }),
};
// The bounded JSON projection's recursive root does not resolve inside a
// property. The enclosing document only needs to declare the object shape.
const jsonObject = boundedNodeJsonRecordSchema.meta({
  type: 'object',
  additionalProperties: true,
  anyOf: undefined,
});
const outputSchema = jsonObject
  .refine(
    (value) => compileModelOutputSchema(value) !== undefined,
    'Expected a bounded object schema using the supported JSON Schema keywords',
  )
  .meta({ ...jsonObject.meta(), title: 'Output schema' });

export const modelConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ ...common, mode: mode('text') }),
  z.strictObject({ ...common, mode: mode('structured'), outputSchema }),
]);
export const modelInputSchema = z.strictObject({
  prompt: z.string().min(1).meta({ title: 'Prompt' }),
});
export const modelOutputSchema = z.union([
  z.strictObject({ text: z.string() }),
  z.strictObject({ data: jsonObject }),
]);
export type ModelConfig = z.output<typeof modelConfigSchema>;
