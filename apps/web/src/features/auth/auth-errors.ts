import { isApiError } from '@/lib/api/api-error';

export function isUnauthenticated(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.kind === 'problem' &&
    error.problem?.code === 'auth.unauthenticated'
  );
}

export function authenticationErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.kind === 'network')
      return 'Pertexo could not reach the identity service. Check your connection and try again.';
    if (error.kind === 'timeout')
      return 'The identity service took too long to respond. Try again.';
    if (error.kind === 'problem' && error.problem?.code === 'auth.forbidden')
      return 'This session cannot perform that action.';
  }
  return 'The session could not be started. Try again.';
}

export function logoutErrorMessage(error: unknown): string {
  if (isApiError(error) && error.kind === 'network')
    return 'Pertexo could not confirm sign out. Check your connection and try again.';
  if (isApiError(error) && error.kind === 'timeout')
    return 'Sign out took too long to confirm. Try again.';
  return 'Pertexo could not confirm sign out. Try again.';
}
