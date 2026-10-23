import { describe, expect, it } from 'vitest';
import {
  storedExecutionJsonStringBytes,
  StoredExecutionValueInvalidError,
} from '@pertexo/node-sdk';

describe('stored execution text', () => {
  it.each([
    ['', 2],
    ['abc', 5],
    ['é', 4],
    ['€', 5],
    ['😀', 6],
    ['e\u0301', 5],
    ['"', 4],
    ['\\', 4],
    ['\n', 4],
    ['\u0001', 8],
  ] as const)('counts the persisted JSON bytes of %j', (text, bytes) => {
    expect(storedExecutionJsonStringBytes(text)).toBe(bytes);
  });

  it.each(['\0', '\ud800', '\udc00', '\udc00\ud800'])(
    'refuses text PostgreSQL cannot store (%j)',
    (text) => {
      expect(() => storedExecutionJsonStringBytes(text)).toThrow(
        StoredExecutionValueInvalidError,
      );
    },
  );

  it.each([
    ['ASCII', 'a'.repeat(262_142)],
    ['supplementary Unicode', `${'😀'.repeat(65_535)}aa`],
    ['JSON escapes', `${'\u0001'.repeat(43_690)}aa`],
  ] as const)(
    'accepts the %s byte budget and refuses one byte over',
    (_encoding, text) => {
      expect(storedExecutionJsonStringBytes(text)).toBe(262_144);
      expect(() => storedExecutionJsonStringBytes(`${text}a`)).toThrow(
        StoredExecutionValueInvalidError,
      );
    },
  );
});
