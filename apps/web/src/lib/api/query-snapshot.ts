import { isApiError } from './error';
import type { QueryClient, QueryKey } from '@tanstack/react-query';

/** A read begun before acceptance cannot confirm or replace the accepted write. */
export async function reconcileQuerySnapshot<Value>(
  cache: QueryClient,
  queryKey: QueryKey,
  source:
    Readonly<{ kind: 'accepted'; value: Value }> | Readonly<{ kind: 'read' }>,
): Promise<Value | undefined> {
  await cache.cancelQueries({ queryKey, exact: true });
  if (source.kind === 'accepted') {
    cache.setQueryData(queryKey, source.value);
    return source.value;
  }
  await cache.refetchQueries({ queryKey, exact: true, type: 'all' });
  const current = cache.getQueryState<Value>(queryKey);
  return current?.status === 'success' ? current.data : undefined;
}

/** Only these refusals invalidate the revision that the person reviewed. */
export function isRevisionConflict(cause: unknown): boolean {
  return (
    isApiError(cause) &&
    cause.status === 409 &&
    [
      'connection.conflict',
      'workspace.conflict',
      'workflow.folder_revision_conflict',
    ].includes(cause.problem?.code ?? '')
  );
}

export type SnapshotRead<Value> =
  | Readonly<{ kind: 'refreshed'; value: Value }>
  | Readonly<{ kind: 'read-failed'; error: unknown }>;

/** A retained cached value is not evidence that the current read succeeded. */
export async function refreshQuerySnapshot<Value>(
  cache: QueryClient,
  queryKey: QueryKey,
): Promise<SnapshotRead<Value>> {
  const value = await reconcileQuerySnapshot<Value>(cache, queryKey, {
    kind: 'read',
  });
  return value === undefined
    ? {
        kind: 'read-failed',
        error:
          cache.getQueryState(queryKey)?.error ??
          new Error('Current settings could not be read.'),
      }
    : { kind: 'refreshed', value };
}

export async function recoverRevisionConflict<Value = unknown>(
  cache: QueryClient,
  queryKey: QueryKey,
  cause: unknown,
): Promise<SnapshotRead<Value> | Readonly<{ kind: 'not-conflict' }>> {
  if (!isRevisionConflict(cause)) return { kind: 'not-conflict' };
  return refreshQuerySnapshot<Value>(cache, queryKey);
}
