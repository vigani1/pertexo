import { describe, expect, it } from 'vitest';
import {
  CANONICAL_JSON_MAX_DEPTH,
  InvalidJsonValueError,
  canonicalJson,
  inspectJsonValue,
} from '../src/canonical-json.js';

describe('canonical JSON', () => {
  it('sorts every object and reports stable UTF-8 bytes', () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: 'é' } })).toBe(
      '{"a":{"x":"é","y":true},"z":1}',
    );
    expect(inspectJsonValue({ list: [1, { x: null }] })).toEqual({
      bytes: 23,
      depth: 3,
      members: 4,
    });
  });
  it('rejects cycles, sparse arrays, prototypes, non-finite numbers, and undefined', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = new Array<unknown>(2);
    sparse[1] = 1;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => 'host',
    });
    const symbol = { [Symbol('host')]: true };
    for (const value of [
      cyclic,
      sparse,
      accessor,
      symbol,
      new Date(),
      Number.NaN,
      undefined,
    ])
      expect(() => canonicalJson(value)).toThrow();
  });

  it('rejects inherited array elements and non-index array properties', () => {
    const inherited = new Array<unknown>(1);
    Object.setPrototypeOf(inherited, { 0: 'inherited' });
    const extra: unknown[] & { note?: string } = [];
    extra.note = 'discarded';
    const hidden: unknown[] = [];
    Object.defineProperty(hidden, 'note', { value: 'discarded' });
    const symbol = Object.assign([], { [Symbol('extra')]: true });

    for (const value of [inherited, extra, hidden, symbol])
      expect(() => canonicalJson(value)).toThrow();
  });

  it('returns its typed boundary error for excessively deep direct input', () => {
    let value: unknown = null;
    for (let depth = 0; depth <= CANONICAL_JSON_MAX_DEPTH; depth += 1)
      value = { value };
    expect(() => canonicalJson(value)).toThrow(InvalidJsonValueError);
  });
});
