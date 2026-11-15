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
import { useLocation, useRouter } from '@tanstack/react-router';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { useSessionOwnerCheck } from '../../data/session-owner-check';
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
  const session = useSessionOwnerCheck(apiClient);
  const router = useRouter();
  const notifications = useNotifications();
  const { checking, check: checkOwner } = session;
  const [stillSignedOut, setStillSignedOut] = useState(false);
  const paused = state.kind === 'paused';
  const owner = paused ? state.userId : undefined;

  const check = useCallback(
    async (asked: boolean) => {
      if (owner === undefined) return;
      const answer = await checkOwner(owner);
      if (answer === undefined) return;
      switch (answer.kind) {
        case 'same':
          setStillSignedOut(false);
          pause.resume();
          session.refreshAfterResume();
          return;
        case 'other':
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
    },
    [checkOwner, notifications, owner, pause, router, session],
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- The check sets state only after its request answers.
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
    session.forgetEverything();
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
