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
    return 'Pertexo couldn’t be reached, so you may still be signed in. Check your connection and try again.';
  if (isApiError(error) && error.kind === 'timeout')
    return 'Pertexo didn’t answer in time, so you may still be signed in. Try again.';
  return 'You may still be signed in on this device. Try again.';
}
