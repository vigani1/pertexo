import { useCallback, useEffect, useRef } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { watchWorkspaceReadDenial } from '@/lib/api/read-denial';
import type { InputCaseCommand } from '../data/input-cases/api';
import { inputCasesKey } from '../data/input-cases/queries';

function evictCases(cache: QueryClient, key: ReturnType<typeof inputCasesKey>) {
  void cache.cancelQueries({ queryKey: key });
  cache.removeQueries({ queryKey: key });
}

export function useCaseOwner({
  api,
  cache,
  userId,
  workspaceId,
  workflowId,
  canWrite,
  enabled,
  onClose,
  onRetire,
}: Readonly<{
  api: ApiClient;
  cache: QueryClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  canWrite: boolean;
  enabled: boolean;
  onClose: () => void;
  onRetire: () => void;
}>) {
  const ownerRef = useRef<symbol | undefined>(undefined);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const retainedRef = useRef<
    Readonly<{ command: InputCaseCommand; createdAt: number }> | undefined
  >(undefined);
  const previousWrite = useRef(canWrite);
  const retire = useCallback(() => {
    ownerRef.current = undefined;
    controllerRef.current?.abort();
    controllerRef.current = undefined;
    retainedRef.current = undefined;
    onRetire();
    evictCases(cache, inputCasesKey(userId, workspaceId, workflowId));
  }, [cache, userId, workspaceId, workflowId, onRetire]);
  useEffect(() => {
    if (!enabled) {
      onClose();
      previousWrite.current = canWrite;
      return;
    }
    const token = Symbol('input-cases');
    ownerRef.current = token;
    const key = inputCasesKey(userId, workspaceId, workflowId);
    function disposeRequest() {
      controllerRef.current?.abort();
      controllerRef.current = undefined;
      retainedRef.current = undefined;
    }
    if (previousWrite.current && !canWrite) retire();
    previousWrite.current = canWrite;
    // Missing optional projections and other workflows do not revoke this
    // case browser. Session/workspace loss and its own authoritative reads do.
    const unsubscribe = watchWorkspaceReadDenial({
      queryClient: cache,
      userId,
      workspaceId,
      counts: ({ key: read, error }) => {
        const isCaseAuthorityLoss =
          ownerRef.current === token &&
          (error.status === 401 ||
            read.length === 0 ||
            (read[0] === 'workflows' &&
              read[1] === 'detail' &&
              read[2] === workflowId &&
              (error.status === 403 ||
                read.length === 3 ||
                read[3] === 'input-cases')));
        return isCaseAuthorityLoss;
      },
      denied: retire,
    });
    return () => {
      unsubscribe();
      if (ownerRef.current === token) ownerRef.current = undefined;
      disposeRequest();
      evictCases(cache, key);
    };
  }, [
    api,
    userId,
    workspaceId,
    workflowId,
    cache,
    canWrite,
    enabled,
    onClose,
    retire,
  ]);
  return { ownerRef, controllerRef, retainedRef, retire };
}
