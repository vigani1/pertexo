import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { currentUserQueryOptions } from '../auth.queries';
import { checkSessionOwner, type SessionOwnerCheck } from './session-identity';

/**
 * Who is signed in now, for a paused page, and what that means for the
 * cache: the same person keeps it, another account starts from nothing.
 * One check at a time; the screen decides what to show from the answer.
 */
export function useSessionOwnerCheck(apiClient: ApiClient) {
  const cache = useQueryClient();
  const inFlight = useRef(false);
  const [checking, setChecking] = useState(false);
  /** Undefined when a check is already running. */
  const check = useCallback(
    async (owner: string): Promise<SessionOwnerCheck | undefined> => {
      if (inFlight.current) return undefined;
      inFlight.current = true;
      setChecking(true);
      try {
        const answer = await checkSessionOwner(apiClient, owner);
        const userKey = currentUserQueryOptions(apiClient).queryKey;
        if (answer.kind === 'same') cache.setQueryData(userKey, answer.user);
        if (answer.kind === 'other') {
          cache.clear();
          cache.setQueryData(userKey, answer.user);
        }
        return answer;
      } finally {
        inFlight.current = false;
        setChecking(false);
      }
    },
    [apiClient, cache],
  );
  return useMemo(() => {
    return {
      checking,
      check,
      /** Reads refused while paused answer again for the same person. */
      refreshAfterResume() {
        void cache.invalidateQueries();
      },
      /** Leaving discards the page, and with it everything it had read. */
      forgetEverything() {
        cache.clear();
      },
    };
  }, [cache, check, checking]);
}
