import { expect, it } from 'vitest';
import {
  parseStoredExecutionValue,
  serializeStoredExecutionValue,
} from '../../../../src/runs/values/stored-execution.js';
import {
  STORED_EXECUTION_VALUE_LIMITS,
  StoredExecutionValueInvalidError,
} from '@pertexo/node-sdk';
import { canonicalJsonOracle, seededJsonCases } from './fixture.js';

export function registerSerializesTrustedDataWithoutInherited(): void {
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
}
