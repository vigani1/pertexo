import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isApiError, type ApiError } from '@/lib/api/error';
import { watchWorkspaceReadDenial } from '@/lib/api/read-denial';
import { workflowOrganizationKeys } from '../data/organization/queries';

export function isOrganizationReadDenied(error: unknown): error is ApiError {
  return isApiError(error) && [401, 403, 404].includes(error.status ?? 0);
}

/** Read ownership exists even when no command dialog is mounted. */
export function useOrganizationReadLifetime(
  userId: string,
  workspaceId: string,
) {
  const cache = useQueryClient();
  const scope = JSON.stringify([userId, workspaceId]);
  const [denial, setDenial] =
    useState<Readonly<{ scope: string; error: ApiError }>>();
  useEffect(() => {
    const key = workflowOrganizationKeys.scope(userId, workspaceId);
    const retire = (error: ApiError) => {
      setDenial({ scope, error });
      // TanStack cancellation fences ignored-transport late responses too.
      // Cancellation is initiated before any protected snapshots are removed.
      void cache.cancelQueries({ queryKey: key });
      cache.removeQueries({ queryKey: key });
    };
    const unsubscribe = watchWorkspaceReadDenial(
      cache,
      userId,
      workspaceId,
      ({ key: read }) => read[0] === 'workflow-organization',
      retire,
    );
    for (const query of cache.getQueryCache().findAll({ queryKey: key })) {
      if (isOrganizationReadDenied(query.state.error))
        retire(query.state.error);
    }
    return unsubscribe;
  }, [cache, scope, userId, workspaceId]);
  const restore = useCallback(() => {
    setDenial((previous) => (previous?.scope === scope ? undefined : previous));
  }, [scope]);
  return { error: denial?.scope === scope ? denial.error : undefined, restore };
}
