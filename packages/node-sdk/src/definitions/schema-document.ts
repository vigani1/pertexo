import { z } from 'zod';

import { inspectBoundedJson, NODE_JSON_LIMITS_V1 } from '../bounded-json.js';
import { cloneAndFreeze } from '../compatibility-canonical.js';

export { NODE_JSON_LIMITS_V1 } from '../bounded-json.js';

export type SchemaJson =
  null | boolean | number | string | readonly SchemaJson[] | SchemaObject;

// Recursive JSON contracts cannot be expressed through a finite Record alias.
export interface SchemaObject {
  readonly [key: string]: SchemaJson;
}

export type SchemaDocument = Readonly<Record<string, SchemaJson>>;

export function isBoundedNodeJson(value: unknown): value is SchemaJson {
  return inspectBoundedJson(value).ok;
}

export const boundedNodeJsonSchema: z.ZodType<SchemaJson> = z
  .unknown()
  .transform((value, context) => {
    const inspected = inspectBoundedJson(value);
    if (inspected.ok) return inspected.value;
    context.addIssue({
      code: 'custom',
      message: 'value exceeds the bounded node JSON contract',
    });
    return z.NEVER;
  });

export const boundedNodeJsonRecordSchema: z.ZodType<SchemaDocument> =
  boundedNodeJsonSchema.refine(
    (value): value is SchemaDocument =>
      value !== null && typeof value === 'object' && !Array.isArray(value),
    'value must be a JSON object',
  );

export const schemaDocumentSchema: z.ZodType<SchemaDocument> =
  boundedNodeJsonSchema.refine(
    (value): value is SchemaDocument =>
      value !== null && typeof value === 'object' && !Array.isArray(value),
    'schema must be bounded JSON object',
  );
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
