import { matchQuery, type QueryClient } from '@tanstack/react-query';
import { isApiError, type ApiError } from './error';
import { isAccessLost } from './error-copy';
import { workspaceReadScope } from './workspace-scope';

/** A failed read in one user's workspace scope: the key after that scope. */
export type WorkspaceReadDenial = Readonly<{
  key: readonly unknown[];
  error: ApiError;
}>;

/**
 * Watches the query cache for a read under `workspaceReadScope` that answered
 * 401, 403 or 404, and calls `denied` when `counts` says that read ends this
 * feature's access. Returns the unsubscribe.
 */
export function watchWorkspaceReadDenial({
  queryClient,
  userId,
  workspaceId,
  counts,
  denied,
}: Readonly<{
  queryClient: QueryClient;
  userId: string;
  workspaceId: string;
  counts: (denial: WorkspaceReadDenial) => boolean;
  denied: (error: ApiError) => void;
}>): () => void {
  const scope = workspaceReadScope(userId, workspaceId);
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated') return;
    if (!matchQuery({ queryKey: scope }, event.query)) return;
    const key = event.query.queryKey as readonly unknown[];
    // An earlier observer may already have removed this query; the event
    // still carries its failure.
    const error: unknown =
      event.action.type === 'error'
        ? event.action.error
        : event.query.state.error;
    if (!isApiError(error) || !isAccessLost(error)) return;
    if (counts({ key: key.slice(scope.length), error })) denied(error);
  });
}
