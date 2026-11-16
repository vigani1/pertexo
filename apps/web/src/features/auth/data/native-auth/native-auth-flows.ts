import type { ApiClient } from '@/lib/api/client';
import {
  requestPasswordReset,
  resendVerificationEmail,
  resetPassword,
  signUpWithEmail,
} from './native-auth.api';

// The email-and-password journeys the sign-in pages run, one function per
// step, so pages hand a step to their request runner without the endpoint.

/** Creates the account; a name and an address count without outer spaces. */
export function signUp(
  apiClient: ApiClient,
  values: Readonly<{ name: string; email: string; password: string }>,
  returnTo: string | undefined,
  signal?: AbortSignal,
) {
  return signUpWithEmail(
    apiClient,
    {
      displayName: values.name.trim(),
      email: values.email.trim(),
      password: values.password,
      returnTo,
    },
    signal,
  );
}

/** Sends the address's verification link again, back to `returnTo`. */
export function resendVerification(
  apiClient: ApiClient,
  email: string,
  returnTo: string | undefined,
  signal?: AbortSignal,
) {
  return resendVerificationEmail(apiClient, { email, returnTo }, signal);
}

/** Mails a reset link; the answer is the same whether the address exists. */
export function sendPasswordReset(
  apiClient: ApiClient,
  email: string,
  signal?: AbortSignal,
) {
  return requestPasswordReset(apiClient, email, signal);
}

/** Sets a new password with the token from the reset link. */
export function resetPasswordWithToken(
  apiClient: ApiClient,
  token: string,
  password: string,
  signal?: AbortSignal,
) {
  return resetPassword(apiClient, { token, password }, signal);
}
