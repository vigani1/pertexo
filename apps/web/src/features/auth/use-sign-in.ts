import { useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { providerName, type SocialProvider } from './model/social-provider';
import {
  isCredentialMismatch,
  isEmailNotVerified,
  providerStartFailure,
  rateLimitSeconds,
  signInFailure,
} from './model/auth-failure';
import { signInWithEmail, startSocialAuthentication } from './native-auth.api';
import { useCountdown } from '@/lib/use-countdown';
import { useLatestRequest } from '@/lib/use-latest-request';

/**
 * Password and provider sign-in for the sign-in lens: one request at a time,
 * a live countdown after a rate limit, and nothing acts on a late answer
 * once the page has moved on.
 */
export function useSignIn({
  apiClient,
  navigateToProvider,
  onAuthenticated,
  onUnverified,
  returnTo,
}: Readonly<{
  apiClient: ApiClient;
  navigateToProvider: (authorizationUrl: string) => void;
  onAuthenticated: () => void;
  onUnverified: (email: string) => void;
  /** An allowlisted path social sign-in comes back to. */
  returnTo?: string | undefined;
}>) {
  const requests = useLatestRequest();
  const rateLimit = useCountdown();
  const [failure, setFailure] = useState<string>();
  const [mismatch, setMismatch] = useState(false);

  function fail(error: unknown, message: string) {
    const seconds = rateLimitSeconds(error);
    if (seconds !== undefined) rateLimit.startSeconds(seconds);
    setFailure(message);
    setMismatch(isCredentialMismatch(error));
  }

  function clearFailure() {
    setFailure(undefined);
    setMismatch(false);
  }

  async function withPassword(email: string, password: string) {
    if (requests.pending) return false;
    const request = requests.begin();
    clearFailure();
    try {
      await signInWithEmail(apiClient, { email, password }, request.signal);
      if (!request.isCurrent()) return false;
      onAuthenticated();
      return true;
    } catch (error) {
      if (!request.isCurrent()) return false;
      if (isEmailNotVerified(error)) onUnverified(email);
      else fail(error, signInFailure(error));
      return false;
    } finally {
      request.finish();
    }
  }

  async function withProvider(provider: SocialProvider) {
    if (requests.pending) return;
    const request = requests.begin();
    clearFailure();
    try {
      const url = await startSocialAuthentication(
        apiClient,
        provider,
        request.signal,
        returnTo,
      );
      // The page stays busy while the browser leaves for the provider, so
      // the request isn't finished here.
      if (request.isCurrent()) navigateToProvider(url);
    } catch (error) {
      if (!request.isCurrent()) return;
      fail(error, providerStartFailure(error, providerName(provider)));
      request.finish();
    }
  }

  return {
    pending: requests.pending,
    failure,
    /** The failure is a refused email and password, so a reset may help. */
    mismatch,
    /** The values changed, so the last failure no longer describes them. */
    clearFailure,
    waitSeconds: rateLimit.remainingSeconds,
    withPassword,
    withProvider,
  };
}
