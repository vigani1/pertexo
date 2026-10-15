import { describe, expect, it } from 'vitest';
import {
  CANONICAL_JSON_MAX_DEPTH,
  InvalidJsonValueError,
  canonicalJson,
  inspectJsonValue,
} from '../../src/json/canonical.js';

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
  it('never invokes inherited toJSON when hashing or measuring arrays', () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    let calls = 0;
    let serialized: string | undefined;
    let inspection: ReturnType<typeof inspectJsonValue> | undefined;
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value: () => {
        calls += 1;
        return 'substituted';
      },
    });
    try {
      serialized = canonicalJson({ nested: [1, { z: ['é'], a: true }] });
      inspection = inspectJsonValue({ nested: [1, { z: ['é'], a: true }] });
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(Array.prototype, 'toJSON');
      else Object.defineProperty(Array.prototype, 'toJSON', previous);
    }
    expect(calls).toBe(0);
    expect(serialized).toBe('{"nested":[1,{"a":true,"z":["é"]}]}');
    expect(inspection).toEqual({ bytes: 36, depth: 4, members: 6 });
  });

  it('preserves the existing canonical representation of numeric object keys', () => {
    expect(canonicalJson({ z: -0, '10': 'ten', a: [null], '2': 'two' })).toBe(
      '{"2":"two","10":"ten","a":[null],"z":0}',
    );
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

it('counts UTF-8 and JSON-escaped bytes identically in browsers and Node', () => {
  const input = { text: '😀é\u0000\ud800' };
  expect(inspectJsonValue(input).bytes).toBe(
    Buffer.byteLength(canonicalJson(input), 'utf8'),
  );
});
