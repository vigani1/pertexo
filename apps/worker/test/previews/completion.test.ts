import { describe, expect, it } from 'vitest';
import { parsePreviewFailure } from '../../src/previews/completion.js';

describe('preview failure result boundary', () => {
  it('retains bounded executor failure details', () => {
    expect(
      parsePreviewFailure({
        status: 'failed',
        safeErrorCode: 'node.invalid',
        errorSummary: 'The input is missing.',
      }),
    ).toEqual({
      status: 'failed',
      safeErrorCode: 'node.invalid',
      errorSummary: 'The input is missing.',
    });
  });
  it.each(['', 'x'.repeat(2049)])(
    'rejects an invalid error summary before storage',
    (errorSummary) => {
      expect(() =>
        parsePreviewFailure({
          status: 'failed',
          safeErrorCode: 'node.invalid',
          errorSummary,
        }),
      ).toThrow();
    },
  );
  it('rejects an invalid safe error code before storage', () => {
    expect(() =>
      parsePreviewFailure({
        status: 'failed',
        safeErrorCode: 'Provider Secret',
      }),
    ).toThrow();
  });
});
