import { isApiError } from '@/lib/api/api-error';

export function isUnauthenticated(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.kind === 'problem' &&
    error.problem?.code === 'auth.unauthenticated'
  );
}

export function logoutErrorMessage(error: unknown): string {
  if (isApiError(error) && error.kind === 'network')
    return 'Pertexo could not confirm sign out. Check your connection and try again.';
  if (isApiError(error) && error.kind === 'timeout')
    return 'Sign out took too long to confirm. Try again.';
  return 'Pertexo could not confirm sign out. Try again.';
}
