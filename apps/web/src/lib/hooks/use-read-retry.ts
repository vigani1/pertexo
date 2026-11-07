import { useEffect } from 'react';
import { isApiError } from '../api/error';
import { useCountdown } from './use-countdown';
/** Each refusal starts its own server-supplied cooldown. */
export function useReadRetry(error: unknown): number {
  const { remainingSeconds, startSeconds } = useCountdown();
  const delay = isApiError(error) ? (error.retryAfterMs ?? 0) : 0;
  useEffect(() => {
    startSeconds(delay / 1_000);
  }, [error, delay, startSeconds]);
  return remainingSeconds;
}
