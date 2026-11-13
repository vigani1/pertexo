import { useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { isApiError, isSessionExpired, type ApiError } from '@/lib/api/error';
import { useLatestRequest } from '@/lib/hooks/use-latest-request';
import { useCountdown } from '@/lib/hooks/use-countdown';
import { useFieldValues } from '@/components/ui/use-field-validation';
import { verifyTwoFactor } from '../../data/two-factor.api';

/** The verification request stays with the flow so every close and mode control sees its busy state. */
export function useTwoFactorVerification({
  apiClient,
  method,
  purpose,
  onVerified,
}: Readonly<{
  apiClient: ApiClient;
  method: 'totp' | 'recovery';
  purpose: 'sign-in' | 'enrollment';
  onVerified: () => void;
}>) {
  const requests = useLatestRequest();
  const cooldown = useCountdown();
  const [failure, setFailure] = useState<string>();
  const fields = useFieldValues(
    {
      code: (value) => {
        if (method === 'totp') {
          if (/^\d{6}$/u.test(value.replace(/\s/gu, ''))) {
            return undefined;
          }
          return 'Enter a 6-digit code.';
        }
        if (value.trim() === '') {
          return 'Enter a recovery code.';
        }
        return undefined;
      },
    },
    { code: '' },
    () => {
      setFailure(undefined);
    },
  );

  async function submit() {
    if (requests.pending || cooldown.remainingSeconds > 0) return;
    const values = fields.validate();
    if (values === undefined) return;
    const request = requests.begin();
    setFailure(undefined);
    try {
      await verifyTwoFactor(
        apiClient,
        {
          code:
            method === 'totp'
              ? values.code.replace(/\s/gu, '')
              : values.code.trim(),
          method,
          purpose,
        },
        request.signal,
      );
      if (!request.isCurrent()) return;
      fields.reset();
      onVerified();
    } catch (error) {
      if (!request.isCurrent()) return;
      fields.reset();
      const apiError = isApiError(error) ? error : undefined;
      const retryAfterMs = apiError?.retryAfterMs;
      if (
        apiError?.status === 429 &&
        apiError.problem?.code !== 'auth.two_factor_locked' &&
        retryAfterMs !== undefined
      )
        cooldown.startSeconds(Math.ceil(retryAfterMs / 1000));
      setFailure(verificationFailure(apiError, purpose));
    } finally {
      request.finish();
    }
  }
  return {
    fields,
    method,
    pending: requests.pending,
    failure,
    waitSeconds: cooldown.remainingSeconds,
    submit,
    reset() {
      requests.abort();
      fields.reset();
      setFailure(undefined);
    },
  };
}

/**
 * What a refused code says. A wrong code leaves any session as it was;
 * only the challenge behind a sign-in can run out.
 */
function verificationFailure(
  error: ApiError | undefined,
  purpose: 'sign-in' | 'enrollment',
): string {
  // No session exists at the sign-in code step. The challenge cookie expires
  // with the challenge, so an expired sign-in arrives with no cookie and the
  // API can only answer auth.unauthenticated.
  if (purpose === 'sign-in' && isSessionExpired(error)) return SIGN_IN_EXPIRED;
  const code = error?.problem?.code;
  const named = code === undefined ? undefined : BY_CODE[code];
  if (named !== undefined) return named;
  return (
    BY_STATUS[error?.status ?? 0] ??
    'We couldn’t confirm the code. Reload to check whether you’re signed in before trying again.'
  );
}

const SIGN_IN_EXPIRED = 'This sign-in expired. Go back and sign in again.';

const BY_CODE: Readonly<Partial<Record<string, string>>> = {
  'auth.two_factor_locked': 'Too many wrong codes. Try again in 15 minutes.',
  'auth.two_factor_code_invalid':
    'That code wasn’t accepted. Check it and try again.',
  'auth.two_factor_challenge_expired': SIGN_IN_EXPIRED,
};

const BY_STATUS: Readonly<Partial<Record<number, string>>> = {
  429: 'Too many attempts. Wait a moment, then try again.',
  409: 'Sign-in settings changed. Go back and sign in again, or use organization sign-in.',
  401: 'That code wasn’t accepted. Check it and try again. If the sign-in expired, go back and sign in again.',
  400: 'That code wasn’t accepted. Check it and try again. If the sign-in expired, go back and sign in again.',
};
