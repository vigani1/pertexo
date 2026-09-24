import { NativeAuthenticationError } from '../native-auth.api';

// One place for what went wrong on the sign-in family of pages, in words.
// Every sentence says what happened and what to do next.

function nativeError(error: unknown): NativeAuthenticationError | undefined {
  return error instanceof NativeAuthenticationError ? error : undefined;
}

/** Seconds to wait when the server rate-limited the request, if it said. */
export function rateLimitSeconds(error: unknown): number | undefined {
  const failure = nativeError(error);
  if (failure?.status !== 429 || failure.retryAfterMs === undefined)
    return undefined;
  return Math.max(1, Math.ceil(failure.retryAfterMs / 1_000));
}

export function isRateLimited(error: unknown): boolean {
  return nativeError(error)?.status === 429;
}

export function isEmailNotVerified(error: unknown): boolean {
  return nativeError(error)?.code === 'auth.email_not_verified';
}

/** The request may have been applied even though no answer arrived. */
function isLostResponse(error: unknown): boolean {
  const kind = nativeError(error)?.kind;
  return kind === 'network' || kind === 'timeout';
}

const TOO_MANY = 'Too many attempts. Wait a moment, then try again.';

export function signInFailure(error: unknown): string {
  const failure = nativeError(error);
  if (failure?.status === 401 || failure?.status === 400)
    return 'That email and password don’t match. Try again, or reset your password.';
  if (failure?.status === 429) return TOO_MANY;
  if (failure?.status === 403)
    return 'Pertexo refused this sign-in. Reload the page and try again.';
  if (failure?.status === 503)
    return 'Sign-in is unavailable right now. Try again in a moment.';
  if (isLostResponse(error))
    return 'We couldn’t confirm the sign-in. Reload to check whether you’re signed in before trying again.';
  return 'We couldn’t sign you in. Try again.';
}

export function providerStartFailure(error: unknown, provider: string): string {
  const failure = nativeError(error);
  if (failure?.status === 429) return TOO_MANY;
  if (failure?.status === 503)
    return `${provider} sign-in is unavailable right now. Try again in a moment, or use another method.`;
  if (isLostResponse(error))
    return `We couldn’t reach ${provider}. Check your connection and try again.`;
  return `We couldn’t start ${provider} sign-in. Try again, or use another method.`;
}

export function signUpFailure(error: unknown): string {
  const failure = nativeError(error);
  if (failure?.status === 422 || failure?.status === 400)
    return 'Pertexo couldn’t create an account with these details. Check them and try again.';
  if (failure?.status === 429) return TOO_MANY;
  if (isLostResponse(error) || (failure?.status ?? 0) >= 500)
    return 'We couldn’t confirm your account was created. Check your inbox for a verification link before trying again.';
  return 'We couldn’t create your account. Try again.';
}

export function resendFailure(error: unknown): string {
  if (isRateLimited(error)) return TOO_MANY;
  if (isLostResponse(error))
    return 'We couldn’t confirm the email was sent. Check your inbox before sending another.';
  return 'We couldn’t send the email. Try again in a moment.';
}

export function recoveryFailure(error: unknown): string {
  if (isRateLimited(error)) return TOO_MANY;
  if (isLostResponse(error))
    return 'We couldn’t confirm the request. A reset email may still arrive, so check your inbox before asking again.';
  return 'We couldn’t request a reset link. Try again.';
}

export function resetFailure(error: unknown): string {
  const failure = nativeError(error);
  if (failure?.code === 'auth.reset_link_invalid' || failure?.status === 400)
    return 'This reset link is invalid or expired. Request a new one.';
  if (failure?.status === 429) return TOO_MANY;
  if (isLostResponse(error))
    return 'We couldn’t confirm the change. Your password may have changed; try signing in with the new one before requesting another link.';
  return 'We couldn’t confirm the change. Try signing in with the new password, or request another link.';
}
