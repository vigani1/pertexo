import { describe, expect, it } from 'vitest';

import { parseRetryAfterMillis } from '../../src/http/retry-after.js';

describe('provider Retry-After minimum', () => {
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
  ])('uses the minimum for invalid or elapsed hints %j', (value) => {
    expect(
      parseRetryAfterMillis(value, Date.parse('2030-01-01T00:00:00Z')),
    ).toBe(1_000);
  });

  it.each([
    ['0', 1_000],
    ['1', 1_000],
    ['12', 12_000],
    ['000012', 12_000],
    ['60', 60_000],
    ['300', 300_000],
    ['999999999', 999999999000],
  ] as const)(
    'preserves %s seconds as a provider minimum',
    (value, expected) => {
      expect(parseRetryAfterMillis(value)).toBe(expected);
    },
  );
  it('uses an explicit clock for an HTTP-date without shortening it', () => {
    expect(
      parseRetryAfterMillis(
        'Tue, 01 Jan 2030 00:00:30 GMT',
        Date.parse('2030-01-01T00:00:00.250Z'),
      ),
    ).toBe(29_750);
  });
});
