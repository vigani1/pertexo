import { describe, expect, it } from 'vitest';

import { randomUuid } from '../../src/identity/index.js';

describe('identity cryptographic helpers', () => {
  it('sets RFC 4122 version and variant bits on exactly 16 random bytes', () => {
    const uuid = randomUuid({
      randomBytes: () => Uint8Array.from({ length: 16 }, (_, index) => index),
    });

    expect(uuid).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  it.each([15, 17])('rejects a random source returning %i bytes', (length) => {
    expect(() =>
      randomUuid({ randomBytes: () => new Uint8Array(length) }),
    ).toThrow(/exactly 16 bytes/u);
  });
});
