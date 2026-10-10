import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { isApiError } from '@/lib/api/error';

export function connectionAccessLost(error: unknown): boolean {
  return isApiError(error) && [401, 403, 404, 409].includes(error.status ?? 0);
}

/** Command conflicts do not revoke the caller's connection-read access. */
export function connectionCommandAccessLost(error: unknown): boolean {
  if (!isApiError(error)) return false;
  if (error.problem?.code === 'connection.reauthorization_required')
    return false;
  return (
    [401, 403, 404].includes(error.status ?? 0) ||
    (error.status === 409 && error.problem?.code === 'workspace.conflict')
  );
}

/** A rejecting read stays alive; canceled sibling reads cannot restore its data. */
export async function forgetDeniedConnections(
  client: QueryClient,
  scope: QueryKey,
  currentKey: QueryKey,
  error: unknown,
): Promise<void> {
  if (!connectionAccessLost(error)) return;
  const cache = client.getQueryCache();
  const current = cache.find({ queryKey: currentKey, exact: true });
  await client.cancelQueries({
    queryKey: scope,
    predicate: (query) => query !== current,
  });
  for (const query of cache.findAll({ queryKey: scope }))
    query.setState({ data: undefined, dataUpdatedAt: 0 });
}
