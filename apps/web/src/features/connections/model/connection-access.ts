import { isApiError } from '@/lib/api/error';

/** Command conflicts do not revoke the caller's connection-read access. */
export function connectionCommandAccessLost(error: unknown): boolean {
  if (!isApiError(error)) return false;
  return (
    [401, 403, 404].includes(error.status ?? 0) ||
    (error.status === 409 && error.problem?.code === 'workspace.conflict')
  );
}
