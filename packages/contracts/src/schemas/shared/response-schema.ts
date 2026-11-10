import { z } from 'zod';

declare const responseSchemaBrand: unique symbol;
export type ResponseSchema<Schema extends z.ZodType = z.ZodType> = Schema & {
  readonly [responseSchemaBrand]: true;
};

const copies = new WeakMap<z.core.$ZodType, z.core.$ZodType>();
const sources = new WeakMap<z.core.$ZodType, z.core.$ZodType>();

/** Response projections ignore future metadata without changing shared request validators. */
export function responseSchema<Schema extends z.ZodType>(
  schema: Schema,
): ResponseSchema<Schema> {
  return responseCopy(schema) as ResponseSchema<Schema>;
}

/** Structural OpenAPI overrides still identify the original bounded domain schema. */
export function responseSchemaSource(schema: z.core.$ZodType) {
  return sources.get(schema) ?? schema;
}

/** JSON Schema consumers must accept the same future metadata as runtime decoders. */
export function responseProjection<Projection>(
  schema: z.core.$ZodType,
  projection: Projection,
): Projection {
  if (sources.has(schema)) allowFutureMembers(projection);
  return projection;
}

function allowFutureMembers(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return;
  const schema = value as Record<string, unknown>;
  if (schema.type === 'object' && schema.additionalProperties === false)
    schema.additionalProperties = true;
  for (const key of [
    '$defs',
    'definitions',
    'properties',
    'patternProperties',
  ]) {
    const map = schema[key];
    if (map !== null && typeof map === 'object' && !Array.isArray(map))
      Object.values(map).forEach(allowFutureMembers);
  }
  for (const key of [
    'items',
    'additionalProperties',
    'not',
    'if',
    'then',
    'else',
    'contains',
    'propertyNames',
    'unevaluatedProperties',
    'unevaluatedItems',
  ])
    allowFutureMembers(schema[key]);
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const members = schema[key];
    if (Array.isArray(members)) members.forEach(allowFutureMembers);
  }
}

function responseCopy(schema: z.core.$ZodType): z.core.$ZodType {
  if (sources.has(schema)) return schema;
  const cached = copies.get(schema);
  if (cached !== undefined) return cached;
  const next = responseDefinition(schema);
  if (next === undefined) return schema;
  const copy = z.core.clone(schema, next, { parent: true });
  copies.set(schema, copy);
  sources.set(copy, schema);
  return copy;
}

function responseDefinition(schema: z.core.$ZodType) {
  const def = (schema as z.core.$ZodTypes)._zod.def;
  if (def.type === 'object') {
    const next = {
      ...def,
      catchall:
        def.catchall === undefined || def.catchall._zod.def.type === 'never'
          ? undefined
          : responseCopy(def.catchall),
    };
    // Zod delays recursive shapes until their schema is registered.
    Object.defineProperty(next, 'shape', {
      get: () =>
        Object.fromEntries(
          Object.entries(def.shape).map(([key, value]) => [
            key,
            responseCopy(value),
          ]),
        ),
    });
    return next;
  }
  if (def.type === 'array')
    return { ...def, element: responseCopy(def.element) };
  if (def.type === 'union')
    return { ...def, options: def.options.map(responseCopy) };
  if (def.type === 'intersection')
    return {
      ...def,
      left: responseCopy(def.left),
      right: responseCopy(def.right),
    };
  if (def.type === 'record')
    return { ...def, valueType: responseCopy(def.valueType) };
  if (def.type === 'tuple')
    return {
      ...def,
      items: def.items.map(responseCopy),
      rest: def.rest == null ? def.rest : responseCopy(def.rest),
    };
  if (def.type === 'pipe')
    return { ...def, in: responseCopy(def.in), out: responseCopy(def.out) };
  if (def.type === 'lazy') {
    // A warmed source cache must not bypass the cloned lazy getter.
    const { _cachedInner: _sourceCache, ...lazy } = def as typeof def & {
      _cachedInner?: unknown;
    };
    return { ...lazy, getter: () => responseCopy(def.getter()) };
  }
  if (def.type === 'map')
    return {
      ...def,
      keyType: responseCopy(def.keyType),
      valueType: responseCopy(def.valueType),
    };
  if (def.type === 'set')
    return { ...def, valueType: responseCopy(def.valueType) };
  if ('innerType' in def)
    return { ...def, innerType: responseCopy(def.innerType) };
  return undefined;
}
