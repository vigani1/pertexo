import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { isApiError } from '@/lib/api/api-error';

export function accessLost(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.status === 401 ||
      error.status === 403 ||
      error.status === 404 ||
      error.status === 409)
  );
}

/** Forget denied snapshots in Query itself, not just the latest render/error. */
export async function forgetDeniedSnapshots(
  client: QueryClient,
  scope: QueryKey,
  currentKey: QueryKey,
  error: unknown,
): Promise<void> {
  if (!accessLost(error)) return;
  const cache = client.getQueryCache();
  const current = cache.find({ queryKey: currentKey, exact: true });
  // Cancel sibling windows before clearing: cancellation can restore pre-fetch data.
  // Keep the rejecting request alive so Query records its original denial normally.
  await client.cancelQueries({
    queryKey: scope,
    predicate: (query) => query !== current,
  });
  for (const query of cache.findAll({ queryKey: scope })) {
    // setQueryData(undefined) is a no-op; setState actually forgets the snapshot
    // without resetting/refetching the active denied request or inventing data.
    query.setState({ data: undefined, dataUpdatedAt: 0 });
  }
}
