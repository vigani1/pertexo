import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/api-error';
import { readFailureReason } from '@/lib/api/api-error-copy';

describe('read failure reasons', () => {
  it('says why a read failed without repeating what failed', () => {
    expect(
      readFailureReason(new ApiError({ kind: 'network', message: 'offline' })),
    ).toBe('Pertexo couldn’t be reached. Check your connection and try again.');
    expect(
      readFailureReason(
        new ApiError({
          kind: 'problem',
          message: 'boom',
          status: 500,
          requestId: '01a0d5c8e7f64d2b',
        }),
      ),
    ).toBe(
      'Something went wrong on our side. Try again; if it keeps happening, quote reference 01a0d5c8.',
    );
    expect(readFailureReason(new Error('parse'))).toBe(
      'Something went wrong on our side. Try again.',
    );
  });
});
