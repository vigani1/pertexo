import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/error';
import {
  accountCommandFailure,
  needsFreshSignIn,
} from '@/features/auth/model/account/failure';

describe('account policy refusals', () => {
  it('explains a missing alternative method without offering a fresh-sign-in loop', () => {
    const error = new ApiError({
      kind: 'problem',
      message: 'Another sign-in method required',
      status: 403,
      problem: {
        type: 'urn:pertexo:problem:auth.alternative_required',
        title: 'Another sign-in method required',
        code: 'auth.alternative_required',
        status: 403,
        requestId: 'alternative-required',
      },
    });
    expect(needsFreshSignIn(error)).toBe(false);
    expect(accountCommandFailure(error, 'changing your email')).toContain(
      'Add another sign-in method',
    );
  });

  // PR #705: only auth.unauthenticated ends the session, whatever the status.
  it.each([
    [401, 'auth.unauthenticated', 'Your session ended. Sign in again.'],
    [401, 'auth.invalid_credentials', 'Changing your password didn’t work.'],
    [400, 'auth.invalid_credentials', 'Changing your password didn’t work.'],
  ] as const)('answers a %i %s by its code', (status, code, message) => {
    const error = new ApiError({
      kind: 'problem',
      message: 'Refused',
      status,
      problem: {
        type: `urn:pertexo:problem:${code}`,
        title: 'Refused',
        code,
        status,
        requestId: 'by-code',
      },
    });
    expect(accountCommandFailure(error, 'changing your password')).toContain(
      message,
    );
  });
});
