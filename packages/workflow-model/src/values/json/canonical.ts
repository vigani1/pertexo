import { utf8ByteLength } from '../text.js';
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface JsonInspection {
  readonly bytes: number;
  readonly depth: number;
  readonly members: number;
}
export const CANONICAL_JSON_MAX_DEPTH = 256;

export class InvalidJsonValueError extends TypeError {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${message} at ${path}`);
    this.name = 'InvalidJsonValueError';
  }
}

function normalize(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  depth: number,
  sortKeys: boolean,
): JsonValue {
  if (depth > CANONICAL_JSON_MAX_DEPTH)
    throw new InvalidJsonValueError(path, 'JSON depth exceeds canonical limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new InvalidJsonValueError(path, 'number must be finite');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object')
    throw new InvalidJsonValueError(path, `unsupported ${typeof value}`);
  if (ancestors.has(value))
    throw new InvalidJsonValueError(path, 'cyclic value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0)
        throw new InvalidJsonValueError(path, 'symbol properties are not JSON');
      if (Object.getOwnPropertyNames(value).length !== value.length + 1)
        throw new InvalidJsonValueError(
          path,
          'array must contain only dense index properties',
        );
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor)
          throw new InvalidJsonValueError(
            `${path}[${String(index)}]`,
            'sparse array',
          );
        if (!('value' in descriptor))
          throw new InvalidJsonValueError(
            `${path}[${String(index)}]`,
            'accessors are not JSON',
          );
        result.push(
          normalize(
            descriptor.value,
            `${path}[${String(index)}]`,
            ancestors,
            depth + 1,
            sortKeys,
          ),
        );
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null)
      throw new InvalidJsonValueError(path, 'object must be plain');
    if (Object.getOwnPropertySymbols(value).length > 0)
      throw new InvalidJsonValueError(path, 'symbol properties are not JSON');
    const result: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    const keys = Object.keys(value);
    for (const key of sortKeys ? keys.sort() : keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor))
        throw new InvalidJsonValueError(
          `${path}.${key}`,
          'accessors are not JSON',
        );
      result[key] = normalize(
        descriptor.value,
        `${path}.${key}`,
        ancestors,
        depth + 1,
        sortKeys,
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** Validated JSON with sorted keys, for comparing and hashing. */
export function canonicalizeJson(value: unknown): JsonValue {
  return normalize(value, '$', new Set(), 0, true);
}

/** Validated JSON that keeps its key order, for data people read. */
export function normalizeJson(value: unknown): JsonValue {
  return normalize(value, '$', new Set(), 0, false);
}
// Normalized objects have no prototype; normalized arrays still inherit toJSON.
// Serialize containers ourselves so neither checksum nor byte inspection runs it.
function serializeNormalizedJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(serializeNormalizedJson).join(',')}]`;
  const object = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.entries(object)
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${serializeNormalizedJson(item)}`,
    )
    .join(',')}}`;
}

export function canonicalJson(value: unknown): string {
  return serializeNormalizedJson(canonicalizeJson(value));
}

/** normalizeJson's text, with keys in the order they were written. */
export function normalizedJson(value: unknown): string {
  return serializeNormalizedJson(normalizeJson(value));
}

export function inspectJsonValue(value: unknown): JsonInspection {
  const normalized = canonicalizeJson(value);
  let depth = 0;
  let members = 0;
  const visit = (current: JsonValue, containerDepth: number): void => {
    if (current === null || typeof current !== 'object') {
      depth = Math.max(depth, containerDepth);
      return;
    }
    const values: readonly JsonValue[] = Array.isArray(current)
      ? (current as readonly JsonValue[])
      : Object.values(current as Readonly<Record<string, JsonValue>>);
    depth = Math.max(depth, containerDepth + 1);
    members += values.length;
    for (const child of values) visit(child, containerDepth + 1);
  };
  visit(normalized, 0);
  return {
    bytes: utf8ByteLength(serializeNormalizedJson(normalized)),
    depth,
    members,
  };
}
