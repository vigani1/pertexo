import { describe, expect, it, vi } from 'vitest';
import {
  isWellFormed,
  utf8ByteLength,
  jsonStringByteLength,
} from '@pertexo/workflow-model';

describe('portable Unicode text', () => {
  it.each([
    ['', true],
    ['plain ASCII', true],
    ['é€😀', true],
    ['\0', true],
    ['\ud800\udc00', true],
    ['\ud800', false],
    ['\udc00', false],
    ['\udc00\ud800', false],
    ['a\ud800b', false],
  ] as const)('checks Unicode well-formedness of %j', (value, expected) => {
    expect(isWellFormed(value)).toBe(expected);
  });
});

it('stops UTF-8 measurement as soon as its caller can refuse the value', () => {
  expect(utf8ByteLength('a'.repeat(1_000_000), { stopAfterBytes: 8 })).toBe(9);
});

it.each(['native', 'browser'] as const)(
  'measures every UTF-8 width and replacement bytes on the %s host',
  async (mode) => {
    vi.resetModules();
    if (mode === 'browser') vi.stubGlobal('Buffer', undefined);
    let actual: number[];
    try {
      const text = await import('@pertexo/workflow-model');
      actual = ['', 'a', 'é', '€', '😀', '\ud800', '\udc00', 'Aé€😀'].map(
        (value) => text.utf8ByteLength(value),
      );
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
    expect(actual).toEqual([0, 1, 2, 3, 4, 3, 3, 10]);
  },
);

describe('bounded JSON text measurement', () => {
  it.each([
    ['', 2],
    ['a', 3],
    ['é', 4],
    ['€', 5],
    ['😀', 6],
    ['Aé€😀', 12],
    ['"', 4],
    ['\\', 4],
    ['\n', 4],
    ['\0', 8],
    ['\u0001', 8],
    ['\ud800', 8],
    ['\udc00', 8],
    ['\ud800\ud800', 14],
  ] as const)('counts JSON escaping without serializing %j', (value, bytes) => {
    expect(jsonStringByteLength(value)).toBe(bytes);
  });
  it('stops after a JSON string exceeds the remaining budget', () => {
    expect(
      jsonStringByteLength('a'.repeat(1_000_000), { stopAfterBytes: 8 }),
    ).toBe(9);
    expect(jsonStringByteLength('', { stopAfterBytes: 1 })).toBe(2);
    expect(jsonStringByteLength('\ud800\ud800', { stopAfterBytes: 8 })).toBe(
      14,
    );
  });
});
