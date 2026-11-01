import { expect, it } from 'vitest';
import {
  parseStoredExecutionValue,
  EXECUTION_JSONB_DATABASE_BACKSTOP_BYTES,
  serializeStoredExecutionJsonValue,
  serializeStoredExecutionValue,
  storedExecutionValuesEqual,
} from '../../../../src/runs/values/stored-execution.js';
import {
  STORED_EXECUTION_VALUE_LIMITS,
  StoredExecutionValueInvalidError,
} from '@pertexo/node-sdk';

export function registerPreservesFormatLikeFieldNames(): void {
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

  it('stores objects in the key order they were written in', () => {
    expect(
      serializeStoredExecutionValue({
        kind: 'inline',
        value: { z: 1, a: { y: 2, b: 3 } },
      }),
    ).toBe('{"kind":"inline","value":{"z":1,"a":{"y":2,"b":3}}}');
    expect(serializeStoredExecutionJsonValue({ z: 1, a: { y: 2, b: 3 } })).toBe(
      '{"a":{"b":3,"y":2},"z":1}',
    );
  });

  it('compares stored values whatever order their keys were written in', () => {
    expect(
      storedExecutionValuesEqual(
        { kind: 'inline', value: { z: 1, a: { y: 2, b: 3 } } },
        '{"kind":"inline","value":{"a":{"b":3,"y":2},"z":1}}',
      ),
    ).toBe(true);
    expect(
      storedExecutionValuesEqual(
        { kind: 'inline', value: { z: 1 } },
        { kind: 'inline', value: { z: 2 } },
      ),
    ).toBe(false);
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
}
