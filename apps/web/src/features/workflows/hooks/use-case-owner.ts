import { useCallback, useEffect, useRef } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { watchWorkspaceReadDenial } from '@/lib/api/read-denial';
import { observeSessionChanges } from '@/features/auth/session/sync.public';
import { inputCasesKey } from '../data/input-cases/workflow-input-cases.queries';

/** The opened case payload belongs to this read lifetime, not to a retained write. */
export function useCaseOwner({
  cache,
  userId,
  workspaceId,
  workflowId,
  enabled,
  onClose,
  onRetire,
}: Readonly<{
  cache: QueryClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  enabled: boolean;
  onClose: () => void;
  onRetire: () => void;
}>) {
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const retire = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = undefined;
    onRetire();
    const queryKey = inputCasesKey(userId, workspaceId, workflowId);
    void cache.cancelQueries({ queryKey });
    cache.removeQueries({ queryKey });
  }, [cache, userId, workspaceId, workflowId, onRetire]);
  useEffect(() => {
    if (!enabled) {
      onClose();
      return;
    }
    const stopSession = observeSessionChanges(retire);
    const stopReads = watchWorkspaceReadDenial({
      queryClient: cache,
      userId,
      workspaceId,
      counts: ({ key, error }) =>
        error.status === 401 ||
        key.length === 0 ||
        (key[0] === 'workflows' &&
          key[1] === 'detail' &&
          key[2] === workflowId &&
          (error.status === 403 ||
            key.length === 3 ||
            key[3] === 'input-cases')),
      denied: retire,
    });
    return () => {
      stopReads();
      stopSession();
      controllerRef.current?.abort();
      controllerRef.current = undefined;
      const queryKey = inputCasesKey(userId, workspaceId, workflowId);
      void cache.cancelQueries({ queryKey });
      cache.removeQueries({ queryKey });
    };
  }, [cache, userId, workspaceId, workflowId, enabled, onClose, retire]);
  return { controllerRef, retire };
}
