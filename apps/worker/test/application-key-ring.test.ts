import { describe, expect, it } from 'vitest';

import { parseApplicationPreviousKeys } from '../src/config/application-key-ring.js';

describe('parseApplicationPreviousKeys', () => {
  it('returns an empty frozen ring when no previous keys are configured', () => {
    const previous = parseApplicationPreviousKeys(undefined);

    expect(previous).toEqual([]);
    expect(Object.isFrozen(previous)).toBe(true);
  });

  it('keeps retired keys readable in their configured order', () => {
    const keys = Array.from({ length: 8 }, (_, index) => ({
      version: `v${String(index)}`,
      key: `key-${String(index)}`,
    }));

    const previous = parseApplicationPreviousKeys(JSON.stringify(keys));

    expect(previous).toEqual(keys);
    expect(Object.isFrozen(previous)).toBe(true);
  });

  it.each([
    ['malformed JSON', '{'],
    ['a non-array value', JSON.stringify({ version: 'v0', key: 'key' })],
    ['an invalid version', JSON.stringify([{ version: '.v0', key: 'key' }])],
    ['an empty key', JSON.stringify([{ version: 'v0', key: '' }])],
    [
      'an unexpected property',
      JSON.stringify([{ version: 'v0', key: 'key', active: true }]),
    ],
    [
      'more than eight retired keys',
      JSON.stringify(
        Array.from({ length: 9 }, (_, index) => ({
          version: `v${String(index)}`,
          key: 'key',
        })),
      ),
    ],
  ])('rejects %s', (_label, input) => {
    expect(() => parseApplicationPreviousKeys(input)).toThrow();
  });
});
