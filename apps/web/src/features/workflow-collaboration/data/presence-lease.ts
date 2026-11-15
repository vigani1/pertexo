import { COLLABORATION_LIMITS } from '@pertexo/workflow-model';
import { useEffect, useRef, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { EditingPresence } from '../model/presence';
import {
  heartbeatPresence,
  leavePresence,
  type CollaborationScope,
} from './collaboration.api';
import { presenceQuery } from './collaboration.queries';

// One identity per page load, never carried over: sessionStorage would hand it to a
// duplicated tab, hiding that real other tab's unsaved work, and the lease's sequence
// restarts with the page. Route remounts retain the lease; pagehide ends it.
export const presenceTabId = crypto.randomUUID();
let sequence = 0;

/**
 * Holds this tab's presence lease while the workflow is open: a heartbeat on
 * an interval and whenever the tab returns, the returned `renew` for a
 * changed state, and
 * a best-effort release when the page goes away.
 */
export function usePresenceLease(
  stableScope: CollaborationScope,
  state: RefObject<EditingPresence>,
  paused: boolean,
): RefObject<(() => void) | undefined> {
  const cache = useQueryClient();
  const renew = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (paused) return;
    const controller = new AbortController();
    const heartbeat = () => {
      if (document.visibilityState !== 'visible') return;
      void heartbeatPresence(
        stableScope,
        presenceTabId,
        { ...state.current, sequence: ++sequence },
        controller.signal,
      )
        .then(() => {
          if (!controller.signal.aborted)
            void cache.invalidateQueries({
              queryKey: presenceQuery(stableScope, presenceTabId).queryKey,
            });
        })
        .catch(() => {
          /* Advisory presence expires; draft saves retain their own authority. */
        });
    };
    renew.current = heartbeat;
    heartbeat();
    const timer = window.setInterval(
      heartbeat,
      COLLABORATION_LIMITS.heartbeatMs,
    );
    const leave = () => {
      void leavePresence(stableScope, presenceTabId).catch(() => {
        /* The lease expires by itself; this only ends it sooner. */
      });
    };
    document.addEventListener('visibilitychange', heartbeat);
    window.addEventListener('online', heartbeat);
    window.addEventListener('pagehide', leave);
    return () => {
      renew.current = undefined;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', heartbeat);
      window.removeEventListener('online', heartbeat);
      window.removeEventListener('pagehide', leave);
    };
  }, [stableScope, cache, paused, state]);
  return renew;
}
