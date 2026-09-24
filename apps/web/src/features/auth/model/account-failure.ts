import { isApiError } from '@/lib/api/api-error';
import { isUncertainOutcome } from '@/lib/api/api-error-copy';

// Account security failures in words. A 403 here means the session is too old
// for a sensitive change (the server asks for a fresh sign-in), not a role.

/** The change needs a sign-in from the last few minutes. */
export function needsFreshSignIn(error: unknown): boolean {
  return isApiError(error) && error.status === 403;
}

export function accountReadFailure(error: unknown, what: string): string {
  if (isApiError(error)) {
    if (error.status === 401)
      return 'Your session ended. Sign in again to see your account.';
    if (error.kind === 'network')
      return `Your ${what} couldn’t be reached. Check your connection and try again.`;
  }
  return `Your ${what} couldn’t be loaded. Try again.`;
}

/** `action` reads as a verb phrase: "changing your password". */
export function accountCommandFailure(error: unknown, action: string): string {
  if (isApiError(error)) {
    if (error.status === 401) return 'Your session ended. Sign in again.';
    if (error.status === 403)
      return 'For your security, sign in again to continue.';
    if (error.status === 429)
      return 'Too many attempts. Wait a moment, then try again.';
  }
  if (isUncertainOutcome(error))
    return `We couldn’t confirm whether ${action} went through. Check before trying again.`;
  return `${action.charAt(0).toUpperCase()}${action.slice(1)} didn’t work. Try again.`;
}
