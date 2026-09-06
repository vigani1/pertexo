import type { JsonValue } from './canonical-json.js';

export type JsonPathSegment = string | number;

export type JsonPathResolution =
  | { readonly kind: 'value'; readonly value: JsonValue }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'error';
      readonly code: 'invalid_path';
      readonly message: string;
    };

/**
 * Parse the platform's deliberately small JSON path dialect.
 *
 * The parser is kept independent from the expression runtime so browser
 * callers and server executors resolve exactly the same own-property paths.
 */
export function parseJsonPath(
  path: string,
): readonly JsonPathSegment[] | undefined {
  if (typeof path !== 'string') return undefined;
  if (path === '$') return Object.freeze([]);
  if (!path.startsWith('$')) return undefined;
  const result: JsonPathSegment[] = [];
  let offset = 1;
  while (offset < path.length) {
    if (path[offset] === '.') {
      const match = /^\.([A-Za-z_][A-Za-z0-9_-]*)/u.exec(path.slice(offset));
      if (!match) return undefined;
      const name = match[1];
      if (name === undefined) return undefined;
      result.push(name);
      offset += match[0].length;
      continue;
    }
    const index = /^\[(0|[1-9][0-9]*)\]/u.exec(path.slice(offset));
    if (index) {
      const value = index[1];
      if (value === undefined) return undefined;
      result.push(Number(value));
      offset += index[0].length;
      continue;
    }
    const property = /^\['((?:[^'\\]|\\['\\])*)'\]/u.exec(path.slice(offset));
    if (property) {
      const name = property[1];
      if (name === undefined) return undefined;
      result.push(name.replace(/\\(['\\])/gu, '$1'));
      offset += property[0].length;
      continue;
    }
    return undefined;
  }
  return Object.freeze(result);
}

export function resolveJsonPath(
  input: JsonValue,
  path: string,
): JsonPathResolution {
  const segments = parseJsonPath(path);
  if (!segments)
    return {
      kind: 'error',
      code: 'invalid_path',
      message: `unsupported JSON path ${path}`,
    };
  let value: JsonValue | undefined = input;
  for (const segment of segments) {
    if (value === null || typeof value !== 'object') return { kind: 'missing' };
    if (typeof segment === 'number') {
      if (!Array.isArray(value) || segment >= value.length)
        return { kind: 'missing' };
      const next: JsonValue | undefined = (value as readonly JsonValue[])[
        segment
      ];
      if (next === undefined) return { kind: 'missing' };
      value = next;
    } else {
      if (Array.isArray(value) || !Object.hasOwn(value, segment))
        return { kind: 'missing' };
      value = (value as Readonly<Record<string, JsonValue>>)[segment];
    }
  }
  return value === undefined ? { kind: 'missing' } : { kind: 'value', value };
}
