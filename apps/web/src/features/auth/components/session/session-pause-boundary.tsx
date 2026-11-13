import { createPortal } from 'react-dom';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useRouter } from '@tanstack/react-router';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { currentUserQueryOptions } from '../../data/auth.queries';
import { checkSessionOwner } from '../../model/session/identity';
import type { SessionPause } from '../../model/session/pause';
import { returnToSearch, allowlistedReturnPath } from '../../model/return-path';
import { SessionPaused } from './session-paused';

/**
 * Keeps the page mounted, hidden and inert, while its session is paused, so
 * whatever was typed into it survives signing in again. The same account
 * resumes it as it was; another account discards it and says so.
 */
export function SessionPauseBoundary({
  pause,
  apiClient,
  children,
}: Readonly<{
  pause: SessionPause;
  apiClient: ApiClient;
  children: ReactNode;
}>) {
  const state = useSyncExternalStore(pause.subscribe, pause.current);
  const queryClient = useQueryClient();
  const router = useRouter();
  const notifications = useNotifications();
  const [checking, setChecking] = useState(false);
  const [stillSignedOut, setStillSignedOut] = useState(false);
  const inFlight = useRef(false);
  const paused = state.kind === 'paused';
  const owner = paused ? state.userId : undefined;

  const check = useCallback(
    async (asked: boolean) => {
      if (owner === undefined || inFlight.current) return;
      inFlight.current = true;
      setChecking(true);
      try {
        const answer = await checkSessionOwner(apiClient, owner);
        const user = currentUserQueryOptions(apiClient).queryKey;
        switch (answer.kind) {
          case 'same':
            queryClient.setQueryData(user, answer.user);
            setStillSignedOut(false);
            pause.resume();
            // Reads refused while paused answer again for the same person.
            void queryClient.invalidateQueries();
            return;
          case 'other':
            queryClient.clear();
            queryClient.setQueryData(user, answer.user);
            setStillSignedOut(false);
            pause.discard();
            notifications.info({
              title: 'Signed in as a different account',
              description: `You’re now signed in as ${answer.user.email}. Unsaved changes on this page belonged to the other account, so they were discarded.`,
            });
            void router.invalidate();
            return;
          case 'signed-out':
            setStillSignedOut(asked);
            pause.pause(owner, 'expired');
            return;
          case 'unreachable':
            pause.pause(owner, 'unreachable');
            return;
        }
      } finally {
        inFlight.current = false;
        setChecking(false);
      }
    },
    [apiClient, notifications, owner, pause, queryClient, router],
  );

  // A discarded page (another account, or a sign-out on purpose) takes the
  // actions it raised with it: a Try again from one account must never run
  // as the next.
  const generation = state.generation;
  useEffect(() => {
    if (generation > 0) notifications.dismissActionable();
  }, [generation, notifications]);

  const reason = paused ? state.reason : undefined;
  // Another tab changed the session: ask at once who is signed in now.
  useEffect(() => {
    if (reason === 'checking') void check(false);
  }, [check, reason]);
  // Coming back from the sign-in tab resumes without another click.
  useEffect(() => {
    if (reason === undefined) return;
    const onReturn = () => {
      if (document.visibilityState === 'visible') void check(false);
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [check, reason]);

  const here = useLocation({
    select: (location) => location.pathname + location.searchStr,
  });
  function leave() {
    const returnTo = allowlistedReturnPath(here);
    queryClient.clear();
    pause.discard();
    // Discarding was the choice, so no leave-unsaved prompt asks again.
    void router.navigate({
      to: '/login',
      search: returnToSearch(returnTo),
      ignoreBlocker: true,
    });
  }

  return (
    <>
      {reason === undefined
        ? null
        : createPortal(
            <PausedLayer>
              <SessionPaused
                reason={reason}
                returnTo={here}
                checking={checking || reason === 'checking'}
                stillSignedOut={stillSignedOut}
                onContinue={() => void check(true)}
                onLeave={leave}
              />
            </PausedLayer>,
            document.body,
          )}
      <div key={state.generation} className="contents">
        {children}
      </div>
    </>
  );
}

/**
 * The pause's own top-level layer. While it's open, every other layer (the
 * app, and the portals its open dialogs and menus render into) is hidden and
 * inert but stays mounted, so their state is kept too. Notifications stay
 * visible: they may say why the session ended.
 */
function PausedLayer({ children }: Readonly<{ children: ReactNode }>) {
  const layer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const own = layer.current;
    const covered = [...document.body.children].filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement &&
        element !== own &&
        element.tagName !== 'SCRIPT' &&
        !element.hidden &&
        element.querySelector('[data-slot="toast-viewport"]') === null,
    );
    for (const element of covered) {
      element.hidden = true;
      element.inert = true;
    }
    return () => {
      for (const element of covered) {
        element.hidden = false;
        element.inert = false;
      }
    };
  }, []);
  return (
    <div ref={layer} data-slot="session-paused">
      {children}
    </div>
  );
}
