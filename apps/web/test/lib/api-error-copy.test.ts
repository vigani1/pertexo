import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/api-error';
import {
  describeCommandError,
  readFailureReason,
} from '@/lib/api/api-error-copy';

it('explains unsupported native draft commands without suggesting a retry', () => {
  expect(
    describeCommandError(
      new ApiError({
        kind: 'problem',
        message: 'Workflow draft operation unavailable',
        status: 409,
        problem: {
          type: 'urn:pertexo:problem:workflow.draft_operation_unavailable',
          title: 'Workflow draft operation unavailable',
          status: 409,
          code: 'workflow.draft_operation_unavailable',
          requestId: 'request-123',
        },
      }),
      'exporting',
    ),
  ).toBe('This operation is not enabled for native workflow drafts.');
});

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
