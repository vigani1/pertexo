import { isAccessLost } from '@/lib/api/error-copy';
import { isSessionExpired } from '@/lib/api/error';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { observeSessionChanges } from '@/features/auth/session/sync.public';

import {
  watchWorkspaceReadDenial,
  type WorkspaceReadDenial,
} from '@/lib/api/read-denial';

/** Private dialog payloads live only for one identity/workspace lifetime. */
export function usePortabilityLifetime(
  userId: string,
  workspaceId: string,
  {
    clear,
    readScope = 'workflow',
  }: Readonly<{ clear: () => void; readScope?: PortabilityReadScope }>,
) {
  const queryClient = useQueryClient();
  const controllers = useRef(new Set<AbortController>());
  const [denied, setDenied] = useState(false);
  const retire = useCallback(() => {
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    clear();
    setDenied(true);
  }, [clear]);
  useEffect(() => {
    const ownedControllers = controllers.current;
    const unsubscribe = observeSessionChanges(retire);
    // An unrelated feature's denial or not-found is not workspace authority
    // loss; an ended session still retires the whole scoped lifetime.
    const unsubscribeCache = watchWorkspaceReadDenial({
      queryClient,
      userId,
      workspaceId,
      counts: (denial) => portabilityAuthorityLost(readScope, denial),
      denied: retire,
    });
    return () => {
      unsubscribe();
      unsubscribeCache();
      for (const controller of ownedControllers) controller.abort();
      ownedControllers.clear();
    };
  }, [queryClient, userId, workspaceId, retire, readScope]);
  const begin = useCallback(() => {
    const controller = new AbortController();
    controllers.current.add(controller);
    return {
      signal: controller.signal,
      current: () => !controller.signal.aborted,
      done: () => controllers.current.delete(controller),
      cancel: () => {
        controller.abort();
        controllers.current.delete(controller);
      },
    };
  }, []);
  const accessFailure = useCallback(
    (error: unknown, source: 'action' | 'read' = 'action') => {
      if (!(source === 'read' ? isAccessLost(error) : isSessionExpired(error)))
        return false;
      retire();
      return true;
    },
    [retire],
  );
  return { denied, begin, accessFailure };
}

type PortabilityReadScope = 'collection' | 'workflow';

function portabilityAuthorityLost(
  readScope: PortabilityReadScope,
  { key, error }: WorkspaceReadDenial,
): boolean {
  if (error.status === 401 || key.length === 0) return true;
  if (key[0] !== 'workflows') return false;
  // Optional row previews cannot retire a collection-owned import.
  return readScope === 'workflow' || key[1] !== 'shape';
}
