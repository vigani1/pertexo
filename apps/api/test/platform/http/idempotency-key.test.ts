import { describe, expect, it } from 'vitest';

import { requestIdempotencyKey } from '../../../src/platform/http/index.js';

describe('Idempotency-Key parsing', () => {
  it.each([
    { name: 'missing', value: undefined },
    { name: 'an empty header array', value: [] },
    { name: 'a singleton non-string array', value: [42] },
    { name: 'multiple values', value: ['one', 'two'] },
    { name: 'empty', value: '' },
    { name: 'comma-combined', value: 'one,two' },
    { name: 'control characters', value: 'contains\nnewline' },
    { name: 'spaces', value: 'contains space' },
    { name: 'too long', value: 'x'.repeat(129) },
  ])('answers 400 for a $name key', ({ value }) => {
    expect(() =>
      requestIdempotencyKey({ 'idempotency-key': value as string }),
    ).toThrow(
      expect.objectContaining({
        code: 'request.invalid',
        safeDetail: 'Idempotency-Key must contain exactly one valid value.',
      }),
    );
  });

  it('accepts scalar and singleton-array keys at both valid length edges, in any header case', () => {
    expect(requestIdempotencyKey({ 'idempotency-key': 'x' })).toBe('x');
    expect(requestIdempotencyKey({ 'Idempotency-Key': ['publish-42'] })).toBe(
      'publish-42',
    );
    expect(requestIdempotencyKey({ 'idempotency-key': 'x'.repeat(128) })).toBe(
      'x'.repeat(128),
    );
  });
});
