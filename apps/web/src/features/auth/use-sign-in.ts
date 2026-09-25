import { useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { providerName, type SocialProvider } from './model/social-provider';
import {
  isEmailNotVerified,
  providerStartFailure,
  rateLimitSeconds,
  signInFailure,
} from './model/auth-failure';
import { signInWithEmail, startSocialAuthentication } from './native-auth.api';
import { useCountdown } from '@/lib/use-countdown';
import { useLatestRequest } from './use-latest-request';

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
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();

  function fail(error: unknown, message: string) {
    const seconds = rateLimitSeconds(error);
    if (seconds !== undefined) rateLimit.startSeconds(seconds);
    setFailure(message);
  }

  async function withPassword(email: string, password: string) {
    if (pending) return false;
    const request = requests.begin();
    setPending(true);
    setFailure(undefined);
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
      if (request.finish()) setPending(false);
    }
  }

  async function withProvider(provider: SocialProvider) {
    if (pending) return;
    const request = requests.begin();
    setPending(true);
    setFailure(undefined);
    try {
      const url = await startSocialAuthentication(
        apiClient,
        provider,
        request.signal,
        returnTo,
      );
      // The page stays busy while the browser leaves for the provider.
      if (request.isCurrent()) navigateToProvider(url);
    } catch (error) {
      if (!request.isCurrent()) return;
      fail(error, providerStartFailure(error, providerName(provider)));
      if (request.finish()) setPending(false);
    }
  }

  return {
    pending,
    failure,
    waitSeconds: rateLimit.remainingSeconds,
    withPassword,
    withProvider,
  };
}
