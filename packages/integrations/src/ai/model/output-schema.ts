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
    !withinDepth(schema, OUTPUT_SCHEMA_LIMITS.depth)
  )
    return undefined;

  const prepared = prepareSchema(schema);
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

function withinDepth(value: SchemaJson, remaining: number): boolean {
  if (value === null || typeof value !== 'object') return true;
  return (
    remaining > 0 &&
    Object.values(value).every((child: SchemaJson) =>
      withinDepth(child, remaining - 1),
    )
  );
}

function isSchemaObject(
  value: SchemaJson | undefined,
): value is SchemaDocument {
  return isRecord(value);
}

function prepareSchema(
  value: SchemaJson | undefined,
): SchemaDocument | undefined {
  if (
    !isSchemaObject(value) ||
    Object.keys(value).some((key) => !keywords.has(key))
  )
    return undefined;

  const {
    type,
    properties,
    required,
    additionalProperties,
    items,
    ...constraints
  } = value;
  if (type !== undefined && !types.has(type)) return undefined;
  if (
    (properties !== undefined ||
      required !== undefined ||
      additionalProperties !== undefined) &&
    type !== 'object'
  )
    return undefined;
  if (
    additionalProperties !== undefined &&
    typeof additionalProperties !== 'boolean'
  )
    return undefined;

  const prepared = { ...constraints, ...(type === undefined ? {} : { type }) };
  if (type === 'array') {
    const itemSchema = prepareSchema(items);
    return itemSchema === undefined
      ? undefined
      : { ...prepared, items: itemSchema };
  }
  if (items !== undefined) return undefined;
  if (type !== 'object') return prepared;

  const object = {
    ...prepared,
    ...(required === undefined ? {} : { required }),
    ...(additionalProperties === undefined ? {} : { additionalProperties }),
  };
  if (properties === undefined) return object;
  if (!isSchemaObject(properties)) return undefined;

  const fields: Record<string, SchemaDocument> = {};
  let prototypeField: SchemaDocument | undefined;
  for (const [key, child] of Object.entries(properties)) {
    const field = prepareSchema(child);
    if (field === undefined) return undefined;
    if (key === '__proto__') prototypeField = field;
    else fields[key] = field;
  }
  return {
    ...object,
    properties: fields,
    // Ajv skips this exact key in properties. A fixed pattern lets it validate
    // the key without compiling any regex supplied by a workflow.
    ...(prototypeField === undefined
      ? {}
      : {
          patternProperties: { '^__proto__(?![\\s\\S])': prototypeField },
        }),
  };
}
