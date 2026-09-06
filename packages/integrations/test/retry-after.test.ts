import { describe, expect, it } from 'vitest';

import { parseBoundedRetryAfterMillis } from '../src/http/retry-after.js';

describe('bounded provider Retry-After policy', () => {
  it.each([
    undefined,
    '',
    '-1',
    '1.5',
    ' 2',
    '2 ',
    '1e3',
    '1234567890',
    'Wed, 21 Oct 2015 07:28:00 GMT',
  ])('uses the minimum for invalid seconds %j', (value) => {
    expect(parseBoundedRetryAfterMillis(value, 60_000)).toBe(1_000);
  });

  it.each([
    ['0', 60_000, 1_000],
    ['1', 60_000, 1_000],
    ['12', 60_000, 12_000],
    ['000012', 60_000, 12_000],
    ['60', 60_000, 60_000],
    ['999999999', 60_000, 60_000],
    ['12', 5_000, 5_000],
  ] as const)(
    'bounds %s seconds by the provider maximum %i',
    (value, maximum, expected) => {
      expect(parseBoundedRetryAfterMillis(value, maximum)).toBe(expected);
    },
  );
});
