import './server-only.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface JsonInspection {
  readonly bytes: number;
  readonly depth: number;
  readonly members: number;
}

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
): JsonValue {
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
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value))
          throw new InvalidJsonValueError(
            `${path}[${String(index)}]`,
            'sparse array',
          );
        result.push(
          normalize(
            (value as unknown[])[index],
            `${path}[${String(index)}]`,
            ancestors,
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
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor))
        throw new InvalidJsonValueError(
          `${path}.${key}`,
          'accessors are not JSON',
        );
      result[key] = normalize(descriptor.value, `${path}.${key}`, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeJson(value: unknown): JsonValue {
  return normalize(value, '$', new Set());
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
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
    bytes: Buffer.byteLength(JSON.stringify(normalized), 'utf8'),
    depth,
    members,
  };
}
