import type { SchemaDocument, SchemaJson } from '@pertexo/node-sdk';
import { isRecord, utf8ByteLength } from '@pertexo/workflow-model';

const OBJECT_SCHEMA_LIMITS = { bytes: 8 * 1_024, depth: 16 } as const;
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

export function prepareBoundedObjectSchema(schema: SchemaDocument) {
  if (
    schema.type !== 'object' ||
    utf8ByteLength(JSON.stringify(schema)) > OBJECT_SCHEMA_LIMITS.bytes ||
    !withinDepth(schema, OBJECT_SCHEMA_LIMITS.depth)
  )
    return undefined;

  return prepareSchema(schema);
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
  const preparedProperties = prepareProperties(properties);
  return preparedProperties === undefined
    ? undefined
    : { ...object, ...preparedProperties };
}

function prepareProperties(properties: SchemaJson): SchemaDocument | undefined {
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
    properties: fields,
    // Ajv skips this exact key in properties. A fixed pattern lets it validate
    // the key without compiling any regex supplied by a workflow.
    ...(prototypeField === undefined
      ? {}
      : { patternProperties: { '^__proto__(?![\\s\\S])': prototypeField } }),
  };
}
