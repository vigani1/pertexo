import { Ajv2020 } from 'ajv/dist/2020.js';
import type { SchemaDocument } from '@pertexo/node-sdk';
import { prepareModelOutputSchema } from './object-schema-shape.js';

const ajv = new Ajv2020({
  strict: false,
  ownProperties: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});

export function compileModelOutputSchema(schema: SchemaDocument) {
  const prepared = prepareModelOutputSchema(schema);
  if (prepared === undefined) return undefined;
  try {
    return ajv.compile<SchemaDocument>(prepared);
  } catch {
    return undefined;
  } finally {
    // Keep the validator for the current invocation without retaining past setup.
    ajv.removeSchema(prepared);
  }
}
