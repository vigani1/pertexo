import { isApiError } from '@/lib/api/error';
import { isUncertainOutcome } from '@/lib/api/error-copy';

// These refusals need an account or policy change; signing in again cannot resolve them.

/** The change needs a sign-in from the last few minutes. */
export function needsFreshSignIn(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.status === 403 &&
    error.problem?.code !== 'auth.recovery_required' &&
    error.problem?.code !== 'auth.organization_email_managed' &&
    error.problem?.code !== 'auth.alternative_required'
  );
}

/** `action` reads as a verb phrase: "changing your password". */
export function accountCommandFailure(error: unknown, action: string): string {
  if (isApiError(error)) {
    if (error.problem?.code === 'auth.alternative_required')
      return 'Add another sign-in method in Account → Security before changing your email. Organization sign-in depends on your verified domain.';
    if (error.problem?.code === 'auth.organization_email_managed')
      return 'Your organization manages this email address. Contact the control workspace owner to change its sign-in policy.';
    if (error.problem?.code === 'auth.method_limit')
      return 'Remove an unused sign-in method before adding another.';
    if (error.problem?.code === 'auth.recovery_required')
      return 'Keep the recovery owner password while organization SSO is required. Turn off required SSO before removing it.';

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
