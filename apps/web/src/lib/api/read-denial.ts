import type { QueryClient } from '@tanstack/react-query';
import { isApiError, type ApiError } from './api-error';

/** A failed read in one user's workspace scope: the key after that scope. */
export type WorkspaceReadDenial = Readonly<{
  key: readonly unknown[];
  error: ApiError;
}>;

/**
 * Watches the query cache for a read under
 * `['identity', userId, 'workspace', workspaceId, ...]` that answered 401,
 * 403 or 404, and calls `denied` when `counts` says that read ends this
 * feature's access. Returns the unsubscribe.
 */
export function watchWorkspaceReadDenial(
  queryClient: QueryClient,
  userId: string,
  workspaceId: string,
  counts: (denial: WorkspaceReadDenial) => boolean,
  denied: (error: ApiError) => void,
): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated') return;
    const key = event.query.queryKey as readonly unknown[];
    if (
      key[0] !== 'identity' ||
      key[1] !== userId ||
      key[2] !== 'workspace' ||
      key[3] !== workspaceId
    )
      return;
    // An earlier observer may already have removed this query; the event
    // still carries its failure.
    const error: unknown =
      event.action.type === 'error'
        ? event.action.error
        : event.query.state.error;
    if (!isApiError(error) || ![401, 403, 404].includes(error.status ?? 0))
      return;
    if (counts({ key: key.slice(4), error })) denied(error);
  });
}
