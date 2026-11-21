import { Ajv2020 } from 'ajv/dist/2020.js';
import type { SchemaDocument, SchemaJson } from '@pertexo/node-sdk';
import { isRecord, utf8ByteLength } from '@pertexo/workflow-model';

const OUTPUT_SCHEMA_LIMITS = { bytes: 8 * 1_024, depth: 16 } as const;
const keywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
]);
const types = new Set<unknown>([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

const ajv = new Ajv2020({
  strict: false,
  ownProperties: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});

export function compileModelOutputSchema(schema: SchemaDocument) {
  if (
    schema.type !== 'object' ||
    utf8ByteLength(JSON.stringify(schema)) > OUTPUT_SCHEMA_LIMITS.bytes ||
    !withinDepth(schema, OUTPUT_SCHEMA_LIMITS.depth) ||
    !inSubset(schema)
  )
    return undefined;

  try {
    return ajv.compile<SchemaDocument>(schema);
  } catch {
    return undefined;
  } finally {
    // Keep the validator for the current invocation without retaining past setup.
    ajv.removeSchema(schema);
  }
}

function withinDepth(value: SchemaJson, remaining: number): boolean {
  if (value === null || typeof value !== 'object') return true;
  return (
    remaining > 0 &&
    Object.values(value).every((child: SchemaJson) =>
      withinDepth(child, remaining - 1),
    )
  );
}

function inSubset(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).some((key) => !keywords.has(key)))
    return false;
  const { type, properties, required, additionalProperties, items } = value;
  if (type !== undefined && !types.has(type)) return false;
  if (type === 'array' ? !inSubset(items) : items !== undefined) return false;
  if (
    properties !== undefined &&
    (type !== 'object' ||
      !isRecord(properties) ||
      !Object.values(properties).every(inSubset))
  )
    return false;
  if (
    (required !== undefined || additionalProperties !== undefined) &&
    type !== 'object'
  )
    return false;
  return (
    additionalProperties === undefined ||
    typeof additionalProperties === 'boolean'
  );
}
