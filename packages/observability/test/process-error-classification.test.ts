import { describe, expect, it } from 'vitest';

import { classifyProcessError } from '../src/process-error-classification.js';

describe('process error classification', () => {
  it.each([
    new Error('ordinary'),
    new TypeError('built-in'),
    Object.assign(new Error('custom'), { name: 'ProviderSecretError' }),
  ])('classifies native Error instances with fixed vocabulary', (value) => {
    expect(classifyProcessError(value)).toBe('Error');
  });

  it.each([
    undefined,
    null,
    false,
    0,
    1n,
    'failure',
    Symbol('failure'),
    {},
    [],
  ])('classifies non-Error values without inspecting them', (value) => {
    expect(classifyProcessError(value)).toBe('NonError');
  });

  it('never reads marker properties or lets hostile reflection escape', () => {
    let markerReads = 0;
    const properties = Object.create(null) as Record<string, unknown>;
    for (const name of ['name', 'message', 'code'])
      Object.defineProperty(properties, name, {
        get() {
          markerReads += 1;
          throw new Error(`${name} marker`);
        },
      });
    const prototypeTrap = new Proxy(properties, {
      getPrototypeOf() {
        throw new Error('prototype marker');
      },
      get() {
        markerReads += 1;
        throw new Error('get marker');
      },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(classifyProcessError(prototypeTrap)).toBe('NonError');
      expect(classifyProcessError(revocable.proxy)).toBe('NonError');
    }
    expect(markerReads).toBe(0);
  });
});
