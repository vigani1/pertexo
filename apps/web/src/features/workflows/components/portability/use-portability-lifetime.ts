import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { assertSessionIdentity } from '@/features/auth/session-identity.public';
import { subscribeSessionChanges } from '@/features/auth/session-sync.public';
import { getAllAccessibleWorkspaces } from '@/features/workspaces/queries.public';
import { isApiError } from '@/lib/api/api-error';
import type { ApiClient } from '@/lib/api/client';
import { isDuplicateAccessLoss } from '../../model/workflow-duplicate-authority';

/** Private dialog payloads live only for one identity/workspace lifetime. */
export function usePortabilityLifetime(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  allowed: boolean,
  clear: () => void,
) {
  const queryClient = useQueryClient();
  const generation = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const [denied, setDenied] = useState(false);
  const retire = useCallback(() => {
    generation.current += 1;
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    clear();
    setDenied(true);
    const queryKey = ['identity', userId, 'workspace', workspaceId];
    void queryClient.cancelQueries({ queryKey });
    queryClient.removeQueries({ queryKey });
  }, [clear, queryClient, userId, workspaceId]);
  useEffect(() => {
    const ownedControllers = controllers.current;
    if (!allowed) queueMicrotask(retire);
    const unsubscribe = subscribeSessionChanges(retire);
    const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated') return;
      const key = event.query.queryKey as readonly unknown[];
      if (
        key[0] === 'identity' &&
        key[1] === userId &&
        key[2] === 'workspace' &&
        key[3] === workspaceId &&
        isApiError(event.query.state.error) &&
        [401, 403, 404].includes(event.query.state.error.status ?? 0) &&
        // An unrelated feature's denial/not-found is not workspace authority
        // loss. Authentication loss still retires the whole scoped lifetime.
        (event.query.state.error.status === 401 ||
          key.length === 4 ||
          key[4] === 'workflows')
      )
        retire();
    });
    return () => {
      unsubscribe();
      unsubscribeCache();
      generation.current += 1;
      for (const controller of ownedControllers) controller.abort();
      ownedControllers.clear();
    };
  }, [allowed, queryClient, userId, workspaceId, retire]);
  const begin = useCallback(() => {
    const controller = new AbortController();
    const epoch = generation.current;
    controllers.current.add(controller);
    return {
      signal: controller.signal,
      current: () => !controller.signal.aborted && generation.current === epoch,
      done: () => controllers.current.delete(controller),
    };
  }, []);
  const verify = useCallback(
    async (signal: AbortSignal, creating: boolean) => {
      await assertSessionIdentity(apiClient, userId, signal);
      const workspace = (
        await getAllAccessibleWorkspaces(apiClient, signal)
      ).find((item) => item.id === workspaceId);
      if (
        workspace?.status !== 'active' ||
        !workspace.capabilities.includes(
          creating ? 'workflow:create' : 'workflow:read',
        )
      ) {
        retire();
        return false;
      }
      return true;
    },
    [apiClient, userId, workspaceId, retire],
  );
  const accessFailure = useCallback(
    (error: unknown) => {
      if (!isDuplicateAccessLoss(error)) return false;
      retire();
      return true;
    },
    [retire],
  );
  return { denied, begin, verify, accessFailure };
}
