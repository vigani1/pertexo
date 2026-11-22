import { boundedNodeJsonRecordSchema, labelledChoice } from '@pertexo/node-sdk';
import { z } from 'zod';
import { compileModelOutputSchema } from '../../structured-data/object-schema.js';

import { modelSettings } from '../model-settings.js';

const modeLabels = {
  text: 'Generate text',
  structured: 'Extract structured data',
} as const;
const modes = labelledChoice(modeLabels);
const mode = <Mode extends keyof typeof modeLabels>(value: Mode) =>
  modes.extract([value]).meta({ const: value, title: modeLabels[value] });
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
  .meta({
    ...jsonObject.meta(),
    title: 'Output schema',
    description: 'Describe the data to extract with a JSON Schema object.',
  });

export const modelConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ ...modelSettings, mode: mode('text') }),
  z.strictObject({ ...modelSettings, mode: mode('structured'), outputSchema }),
]);
export const modelInputSchema = z.strictObject({
  prompt: z.string().min(1).meta({ title: 'Prompt' }),
});
export const modelOutputSchema = z.union([
  z.strictObject({ text: z.string() }),
  z.strictObject({ data: jsonObject }),
]);
export type ModelConfig = z.output<typeof modelConfigSchema>;
