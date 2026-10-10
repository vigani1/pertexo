import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  EXECUTION_JSONB_DATABASE_BACKSTOP_BYTES,
  parseStoredExecutionValue,
  serializeStoredExecutionValue,
  STORED_EXECUTION_VALUE_LIMITS,
  StoredExecutionValueInvalidError,
} from '../../src/platform/stored-execution-value.js';

function canonicalJsonOracle(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((child) => canonicalJsonOracle(child)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJsonOracle((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}

function seededJsonCases(seed: number, count: number): unknown[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  const create = (depth: number): unknown => {
    const kind = depth === 0 ? next() % 4 : next() % 6;
    if (kind === 0) return null;
    if (kind === 1) return (next() & 1) === 1;
    if (kind === 2) return (next() % 20_001) - 10_000;
    if (kind === 3) return `value-${String(next())}-界`;
    const size = next() % 4;
    if (kind === 4)
      return Array.from({ length: size }, () => create(depth - 1));
    return Object.fromEntries(
      Array.from({ length: size }, (_, index) => [
        `key-${String(index)}-${String(next() % 7)}`,
        create(depth - 1),
      ]),
    );
  };
  return Array.from({ length: count }, () => create(3));
}

describe('StoredExecutionValue', () => {
  it('preserves format-like field names in user JSON', () => {
    const value = {
      schemaVersion: 17,
      engineVersion: 'customer-engine',
      policyVersion: 42,
      formatVersion: 3,
    };
    const stored = { kind: 'inline', value };
    expect(
      parseStoredExecutionValue(serializeStoredExecutionValue(stored)),
    ).toEqual(stored);
  });
  it('round-trips inline JSON at the exact encoded-value byte limit', () => {
    const value = 'x'.repeat(STORED_EXECUTION_VALUE_LIMITS.inlineBytes - 2);
    const stored = parseStoredExecutionValue({
      kind: 'inline',
      value,
    });

    expect(stored).toEqual({ kind: 'inline', value });
    expect(
      parseStoredExecutionValue(serializeStoredExecutionValue(stored)),
    ).toEqual(stored);
    expect(() =>
      parseStoredExecutionValue({
        kind: 'inline',
        value: `${value}x`,
      }),
    ).toThrow(StoredExecutionValueInvalidError);
  });

  it('accepts exactly 64 levels and 10,000 members but rejects the next one', () => {
    let depth64: unknown = null;
    for (let depth = 0; depth < STORED_EXECUTION_VALUE_LIMITS.depth; depth += 1)
      depth64 = [depth64];
    expect(() =>
      parseStoredExecutionValue({
        kind: 'inline',
        value: depth64,
      }),
    ).not.toThrow();

    expect(() =>
      parseStoredExecutionValue({
        kind: 'inline',
        value: [depth64],
      }),
    ).toThrow(StoredExecutionValueInvalidError);

    const exactMembers = Array.from(
      { length: STORED_EXECUTION_VALUE_LIMITS.members },
      () => null,
    );
    expect(() =>
      parseStoredExecutionValue({
        kind: 'inline',
        value: exactMembers,
      }),
    ).not.toThrow();
    expect(() =>
      parseStoredExecutionValue({
        kind: 'inline',
        value: [...exactMembers, null],
      }),
    ).toThrow(StoredExecutionValueInvalidError);
  });

  it('copies and deeply freezes own plain JSON data', () => {
    const source = Object.assign(
      Object.create(null) as Record<string, unknown>,
      {
        nested: [{ ok: true }],
      },
    );
    const stored = parseStoredExecutionValue({
      kind: 'inline',
      value: source,
    });

    expect(stored).toEqual({
      kind: 'inline',
      value: { nested: [{ ok: true }] },
    });
    expect(Object.isFrozen(stored)).toBe(true);
    if (
      stored.kind !== 'inline' ||
      typeof stored.value !== 'object' ||
      stored.value === null
    )
      throw new Error('inline object fixture was not retained');
    expect(Object.isFrozen(stored.value)).toBe(true);
    const normalized = stored.value as {
      readonly nested: readonly Readonly<{ ok: boolean }>[];
    };
    const sourceNested = source.nested as { ok: boolean }[];
    const sourceFirst = sourceNested[0];
    if (sourceFirst === undefined) throw new Error('source fixture is empty');
    expect(normalized).not.toBe(source);
    expect(normalized.nested).not.toBe(sourceNested);
    expect(normalized.nested[0]).not.toBe(sourceFirst);
    expect(Object.isFrozen(normalized.nested)).toBe(true);
    expect(Object.isFrozen(normalized.nested[0])).toBe(true);
    sourceFirst.ok = false;
    sourceNested.push({ ok: false });
    expect(normalized).toEqual({ nested: [{ ok: true }] });
  });

  it('counts escaped controls and multibyte keys and values by canonical UTF-8 bytes', () => {
    for (const value of [{ '\n': '\n' }, { é: '界' }, { emoji: '😀' }]) {
      const serialized = serializeStoredExecutionValue({
        kind: 'inline',
        value,
      });
      const encodedValue = serialized.slice(
        '{"kind":"inline","value":'.length,
        -1,
      );
      expect(Buffer.byteLength(encodedValue, 'utf8')).toBe(
        Buffer.byteLength(JSON.stringify(value), 'utf8'),
      );
    }
  });

  it('applies the serialized JSONB backstop before parsing stored text', () => {
    const oversized = ' '.repeat(EXECUTION_JSONB_DATABASE_BACKSTOP_BYTES + 1);
    expect(() => parseStoredExecutionValue(oversized)).toThrow(
      StoredExecutionValueInvalidError,
    );
  });

  it('preserves numeric exponent semantics while keeping the application encoding distinct', () => {
    const serialized = serializeStoredExecutionValue({
      kind: 'inline',
      value: 1e-300,
    });
    expect(serialized).toContain('1e-300');
    expect(parseStoredExecutionValue(serialized)).toEqual({
      kind: 'inline',
      value: 1e-300,
    });
  });

  it('retains an own __proto__ data field without changing the cloned prototype', () => {
    const value = Object.defineProperty({}, '__proto__', {
      enumerable: true,
      value: { safe: true },
    });
    const parsed = parseStoredExecutionValue({
      kind: 'inline',
      value,
    });
    if (
      parsed.kind !== 'inline' ||
      parsed.value === null ||
      typeof parsed.value !== 'object'
    )
      throw new Error('inline object fixture was not retained');
    expect(Object.getPrototypeOf(parsed.value)).toBeNull();
    expect(Object.hasOwn(parsed.value, '__proto__')).toBe(true);
    expect(Reflect.get(parsed.value, '__proto__')).toEqual({ safe: true });
  });

  it('serializes objects canonically without changing the exact value bound', () => {
    expect(
      serializeStoredExecutionValue({
        kind: 'inline',
        value: { z: 1, a: { y: 2, b: 3 } },
      }),
    ).toBe('{"kind":"inline","value":{"a":{"b":3,"y":2},"z":1}}');
  });

  it('normalizes negative zero to the persisted JSON value', () => {
    const parsed = parseStoredExecutionValue({
      kind: 'inline',
      value: -0,
    });
    if (parsed.kind !== 'inline')
      throw new Error('inline fixture was not retained');
    expect(Object.is(parsed.value, 0)).toBe(true);
    expect(Object.is(parsed.value, -0)).toBe(false);
    expect(serializeStoredExecutionValue(parsed)).toBe(
      '{"kind":"inline","value":0}',
    );
  });

  it('serializes trusted data without inherited toJSON hooks', () => {
    const objectDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'toJSON',
    );
    const arrayDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      'toJSON',
    );
    let hookCalls = 0;
    const hook = function (this: unknown): unknown {
      hookCalls += 1;
      return this;
    };
    try {
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true,
        value: hook,
      });
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        value: hook,
      });
      expect(
        serializeStoredExecutionValue({
          kind: 'inline',
          value: { nested: [1, 2, 3] },
        }),
      ).toBe('{"kind":"inline","value":{"nested":[1,2,3]}}');
      expect(hookCalls).toBe(0);
    } finally {
      if (objectDescriptor === undefined)
        Reflect.deleteProperty(Object.prototype, 'toJSON');
      else Object.defineProperty(Object.prototype, 'toJSON', objectDescriptor);
      if (arrayDescriptor === undefined)
        Reflect.deleteProperty(Array.prototype, 'toJSON');
      else Object.defineProperty(Array.prototype, 'toJSON', arrayDescriptor);
    }
  });

  it('rejects oversized dense arrays, objects, and envelopes', () => {
    const dense = Array.from(
      { length: STORED_EXECUTION_VALUE_LIMITS.members + 1 },
      () => null,
    );
    const wide: Record<string, null> = {};
    for (
      let index = 0;
      index <= STORED_EXECUTION_VALUE_LIMITS.members;
      index += 1
    )
      wide[`field-${String(index)}`] = null;
    const wideEnvelope: Record<string, unknown> = {
      kind: 'inline',
      value: null,
    };
    for (let index = 0; index < 10_000; index += 1)
      wideEnvelope[`extra-${String(index)}`] = null;

    for (const candidate of [dense, wide]) {
      expect(() =>
        parseStoredExecutionValue({
          kind: 'inline',
          value: candidate,
        }),
      ).toThrow(StoredExecutionValueInvalidError);
    }
    expect(() => parseStoredExecutionValue(wideEnvelope)).toThrow(
      StoredExecutionValueInvalidError,
    );
  });

  it('rejects oversized scalar strings incrementally, including escape expansion', () => {
    const hugeKey = 'k'.repeat(2_000_000);
    for (const value of [
      'x'.repeat(2_000_000),
      '"'.repeat(140_000),
      { [hugeKey]: null },
    ]) {
      expect(() =>
        parseStoredExecutionValue({
          kind: 'inline',
          value,
        }),
      ).toThrow(StoredExecutionValueInvalidError);
    }
  });

  it.each([
    ['U+0000 value', '\u0000'],
    ['lone high surrogate value', '\ud800'],
    ['lone low surrogate value', '\udc00'],
  ])('rejects PostgreSQL-incompatible %s', (_name, value) => {
    expect(() => parseStoredExecutionValue({ kind: 'inline', value })).toThrow(
      StoredExecutionValueInvalidError,
    );
  });

  it('rejects PostgreSQL-incompatible keys and accepts valid Unicode pairs', () => {
    for (const key of ['bad\u0000key', 'bad\ud800key', 'bad\udc00key']) {
      expect(() =>
        parseStoredExecutionValue({
          kind: 'inline',
          value: { [key]: true },
        }),
      ).toThrow(StoredExecutionValueInvalidError);
    }
    expect(() =>
      parseStoredExecutionValue({
        kind: 'inline',
        value: { 'emoji-😀': '😀' },
      }),
    ).not.toThrow();
  });

  it.each([
    ['proxy', () => new Proxy({}, {})],
    [
      'accessor',
      () =>
        Object.defineProperty({}, 'secret', { enumerable: true, get: () => 1 }),
    ],
    ['sparse array', () => new Array<unknown>(1)],
    ['non-finite number', () => Number.POSITIVE_INFINITY],
    ['undefined', () => undefined],
    ['symbol', () => Symbol('not-json')],
    ['non-plain object', () => new Date(0)],
  ])('rejects %s input without invoking user code', (_name, createValue) => {
    expect(() =>
      parseStoredExecutionValue({
        kind: 'inline',
        value: createValue(),
      }),
    ).toThrow(StoredExecutionValueInvalidError);
  });

  it('rejects cycles, aliases remain valid JSON, and accessors never run', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      parseStoredExecutionValue({
        kind: 'inline',
        value: cyclic,
      }),
    ).toThrow(StoredExecutionValueInvalidError);

    const shared = { value: 1 };
    expect(() =>
      parseStoredExecutionValue({
        kind: 'inline',
        value: [shared, shared],
      }),
    ).not.toThrow();

    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 1;
      },
    });
    expect(() =>
      parseStoredExecutionValue({
        kind: 'inline',
        value: accessor,
      }),
    ).toThrow(StoredExecutionValueInvalidError);
    expect(getterCalls).toBe(0);
  });

  it('rejects revoked proxies and hidden or symbol-valued inline fields', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const hidden = Object.defineProperty({}, 'hidden', {
      enumerable: false,
      value: true,
    });
    const symbolField = { [Symbol('hidden')]: true };
    for (const value of [revoked.proxy, hidden, symbolField])
      expect(() =>
        parseStoredExecutionValue({
          kind: 'inline',
          value,
        }),
      ).toThrow(StoredExecutionValueInvalidError);
  });

  it('matches an independent bounded canonical JSON oracle for seed 163', () => {
    for (const value of seededJsonCases(163, 200)) {
      expect(
        serializeStoredExecutionValue({
          kind: 'inline',
          value,
        }),
      ).toBe(`{"kind":"inline","value":${canonicalJsonOracle(value)}}`);
    }
  });

  it('round-trips an artifact reference and rejects malformed envelopes', () => {
    const artifactId = randomUUID();
    expect(
      parseStoredExecutionValue(
        serializeStoredExecutionValue({
          kind: 'artifact',
          artifactId,
        }),
      ),
    ).toEqual({ kind: 'artifact', artifactId });

    for (const malformed of [
      { kind: 'artifact', artifactId: 'not-a-uuid' },
      {
        kind: 'artifact',
        artifactId: '00000000-0000-0000-8000-000000000000',
      },
      {
        kind: 'artifact',
        artifactId: '00000000-0000-4000-0000-000000000000',
      },
      {
        kind: 'artifact',
        artifactId: artifactId.toUpperCase(),
      },
      { kind: 'artifact', artifactId, extra: true },
      { kind: 'inline' },
      '{not json',
    ]) {
      expect(() => parseStoredExecutionValue(malformed)).toThrow(
        StoredExecutionValueInvalidError,
      );
    }

    const hidden = Object.defineProperty(
      { kind: 'artifact', artifactId },
      'hidden',
      { enumerable: false, value: true },
    );
    expect(() => parseStoredExecutionValue(hidden)).toThrow(
      StoredExecutionValueInvalidError,
    );
  });
});
