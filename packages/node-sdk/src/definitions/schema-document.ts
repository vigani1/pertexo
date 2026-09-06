import { z } from 'zod';

import { cloneAndFreeze } from '../compatibility-canonical.js';

export type SchemaJson =
  null | boolean | number | string | readonly SchemaJson[] | SchemaObject;

// Recursive JSON contracts cannot be expressed through a finite Record alias.
export interface SchemaObject {
  readonly [key: string]: SchemaJson;
}

export type SchemaDocument = Readonly<Record<string, SchemaJson>>;

export const NODE_JSON_LIMITS_V1 = Object.freeze({
  bytes: 1_048_576,
  depth: 64,
  members: 10_000,
});

function inspectBoundedNodeJson(value: unknown): value is SchemaJson {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return (
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      NODE_JSON_LIMITS_V1.bytes
    );
  if (typeof value !== 'object') return false;
  const stack: { readonly value: object; readonly depth: number }[] = [
    { value, depth: 1 },
  ];
  const seen = new Set<object>();
  let members = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current.depth > NODE_JSON_LIMITS_V1.depth || seen.has(current.value))
      return false;
    seen.add(current.value);
    if (
      !Array.isArray(current.value) &&
      Object.getPrototypeOf(current.value) !== Object.prototype &&
      Object.getPrototypeOf(current.value) !== null
    )
      return false;
    if (Object.getOwnPropertySymbols(current.value).length > 0) return false;
    if (
      Array.isArray(current.value) &&
      current.value.length > NODE_JSON_LIMITS_V1.members
    )
      return false;
    const keys = Array.isArray(current.value)
      ? Array.from({ length: current.value.length }, (_, index) =>
          String(index),
        )
      : Object.keys(current.value);
    if (
      Array.isArray(current.value) &&
      (Object.keys(current.value).length !== current.value.length ||
        keys.some((key) => !(Number(key) in current.value)))
    )
      return false;
    for (const key of keys) {
      members += 1;
      if (members > NODE_JSON_LIMITS_V1.members) return false;
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (descriptor === undefined || !('value' in descriptor)) return false;
      const child: unknown = descriptor.value;
      if (
        child === null ||
        typeof child === 'string' ||
        typeof child === 'boolean' ||
        (typeof child === 'number' && Number.isFinite(child))
      )
        continue;
      if (typeof child !== 'object') return false;
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  try {
    return (
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      NODE_JSON_LIMITS_V1.bytes
    );
  } catch {
    return false;
  }
}

export function isBoundedNodeJson(value: unknown): value is SchemaJson {
  try {
    return inspectBoundedNodeJson(value);
  } catch {
    return false;
  }
}

export const boundedNodeJsonSchema: z.ZodType<SchemaJson> =
  z.custom<SchemaJson>(isBoundedNodeJson, {
    message: 'value exceeds the bounded node JSON contract',
  });

export const boundedNodeJsonRecordSchema: z.ZodType<SchemaDocument> =
  boundedNodeJsonSchema.refine(
    (value): value is SchemaDocument =>
      value !== null && typeof value === 'object' && !Array.isArray(value),
    'value must be a JSON object',
  );

function isSchemaDocument(value: unknown): value is SchemaDocument {
  return (
    isBoundedNodeJson(value) &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

export const schemaDocumentSchema = z.custom<SchemaDocument>(isSchemaDocument, {
  error: 'schema must be bounded JSON object',
});
function boundedSchemaDocument(kind: 'value' | 'record'): SchemaDocument {
  const structural = z.toJSONSchema(
    kind === 'value' ? z.json() : z.record(z.string(), z.json()),
  );
  return cloneAndFreeze(
    schemaDocumentSchema.parse({
      ...structural,
      'x-pertexo-node-json-limits': NODE_JSON_LIMITS_V1,
    }),
  );
}

export const BOUNDED_NODE_JSON_SCHEMA_DOCUMENT = boundedSchemaDocument('value');
export const BOUNDED_NODE_JSON_RECORD_SCHEMA_DOCUMENT =
  boundedSchemaDocument('record');

export interface SchemaProjectionOptions {
  readonly runtimeOnlySemantics?: readonly [string, ...string[]];
}

export function generateSchemaDocument(
  schema: z.ZodType,
  options: SchemaProjectionOptions = {},
): SchemaDocument {
  if (
    options.runtimeOnlySemantics !== undefined &&
    (options.runtimeOnlySemantics.length === 0 ||
      options.runtimeOnlySemantics.some(
        (semantic) => semantic.length === 0 || semantic.length > 256,
      ))
  )
    throw new TypeError(
      'runtime-only schema semantics must be non-empty bounded descriptions',
    );
  const projection =
    schema === boundedNodeJsonSchema
      ? BOUNDED_NODE_JSON_SCHEMA_DOCUMENT
      : schema === boundedNodeJsonRecordSchema
        ? BOUNDED_NODE_JSON_RECORD_SCHEMA_DOCUMENT
        : schemaDocumentSchema.parse(z.toJSONSchema(schema));
  return cloneAndFreeze(
    schemaDocumentSchema.parse({
      ...projection,
      ...(options.runtimeOnlySemantics === undefined
        ? {}
        : {
            'x-pertexo-runtime-only-semantics': [
              ...options.runtimeOnlySemantics,
            ],
          }),
    }),
  );
}
