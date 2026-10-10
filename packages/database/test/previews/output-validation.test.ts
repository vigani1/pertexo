import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { isValidStoredExecutionOutput } from '../../src/previews/repository.js';

describe('preview stored output validation', () => {
  it('accepts every executor envelope supported by the canonical stored-value contract', () => {
    const nested = { ok: true };
    Object.setPrototypeOf(nested, null);
    const nullPrototypeValue = {
      '': null,
      nested,
    };
    Object.setPrototypeOf(nullPrototypeValue, null);
    const nullPrototypeEnvelope = {
      kind: 'inline',
      value: nullPrototypeValue,
    };
    Object.setPrototypeOf(nullPrototypeEnvelope, null);

    expect(isValidStoredExecutionOutput(nullPrototypeEnvelope)).toBe(true);
    expect(
      isValidStoredExecutionOutput({
        kind: 'artifact',
        artifactId: randomUUID(),
      }),
    ).toBe(true);
    expect(
      isValidStoredExecutionOutput({
        kind: 'inline',
        value: null,
      }),
    ).toBe(true);
  });

  it('returns false for hostile or lossy values without invoking accessors', () => {
    let getterCalls = 0;
    const accessorValue = Object.defineProperty({}, 'unsafe', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error('must not run');
      },
    });
    const throwingProxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('must not escape');
        },
      },
    );
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const sparse: unknown[] = [];
    sparse.length = 1;
    const symbolMember = { ok: true } as Record<PropertyKey, unknown>;
    symbolMember[Symbol('hidden')] = true;
    const cases = [
      { kind: 'inline', value: accessorValue },
      { kind: 'inline', value: throwingProxy },
      { kind: 'inline', value: revocable.proxy },
      { kind: 'inline', value: () => undefined },
      { kind: 'inline', value: Symbol('invalid') },
      { kind: 'inline', value: sparse },
      { kind: 'inline', value: symbolMember },
      {
        kind: 'inline',
        value: 'x'.repeat(262_145),
      },
    ];

    for (const value of cases)
      expect(isValidStoredExecutionOutput(value)).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it('rejects excessive depth as a total boolean result', () => {
    let value: unknown = null;
    for (let depth = 0; depth < 65; depth += 1) value = { nested: value };

    expect(
      isValidStoredExecutionOutput({
        kind: 'inline',
        value,
      }),
    ).toBe(false);
  });
});
