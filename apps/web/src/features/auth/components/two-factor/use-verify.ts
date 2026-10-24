import { useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
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
      if (
        isApiError(error) &&
        error.problem?.code === 'auth.two_factor_locked'
      ) {
        setFailure('Too many wrong codes. Try again in 15 minutes.');
      } else if (isApiError(error) && error.status === 429) {
        if (error.retryAfterMs !== undefined)
          cooldown.startSeconds(Math.ceil(error.retryAfterMs / 1000));
        setFailure('Too many attempts. Wait a moment, then try again.');
      } else if (isApiError(error) && error.status === 409) {
        setFailure(
          'Sign-in settings changed. Go back and sign in again, or use organization sign-in.',
        );
      } else if (
        isApiError(error) &&
        (error.status === 401 || error.status === 400)
      ) {
        setFailure(
          'That code wasn’t accepted. Check it and try again. If the sign-in expired, go back and sign in again.',
        );
      } else {
        setFailure(
          'We couldn’t confirm the code. Reload to check whether you’re signed in before trying again.',
        );
      }
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
