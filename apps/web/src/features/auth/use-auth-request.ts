import { useState } from 'react';
import { rateLimitSeconds } from './model/auth-failure';
import { useCountdown } from '@/lib/use-countdown';
import { useLatestRequest } from './use-latest-request';

/**
 * One form's request to the authentication service: pending while in
 * flight, a sentence when it fails, and a live countdown after a rate
 * limit. Late answers are ignored once the form has moved on or unmounted.
 */
export function useAuthRequest(describeFailure: (error: unknown) => string) {
  const requests = useLatestRequest();
  const rateLimit = useCountdown();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();

  async function run(
    work: (signal: AbortSignal) => Promise<unknown>,
    onSuccess: () => void,
  ) {
    const request = requests.begin();
    setPending(true);
    setFailure(undefined);
    try {
      await work(request.signal);
      if (request.isCurrent()) onSuccess();
    } catch (error) {
      if (!request.isCurrent()) return;
      const seconds = rateLimitSeconds(error);
      if (seconds !== undefined) rateLimit.startSeconds(seconds);
      setFailure(describeFailure(error));
    } finally {
      if (request.finish()) setPending(false);
    }
  }

  /** Checks the form, then sends it unless a request is already in flight. */
  async function submit<Values>(
    validate: () => Values | undefined,
    work: (values: Values, signal: AbortSignal) => Promise<unknown>,
    onSuccess: (values: Values) => void,
  ) {
    if (pending) return;
    const values = validate();
    if (values === undefined) return;
    await run(
      (signal) => work(values, signal),
      () => {
        onSuccess(values);
      },
    );
  }

  return {
    pending,
    failure,
    waitSeconds: rateLimit.remainingSeconds,
    submit,
  };
}
