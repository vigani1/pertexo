import type { InvitationAcceptanceJourney } from '@pertexo/contracts/schemas/identity-workspace';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import {
  acceptJourney,
  leaveJourney,
  reconcileJourney,
  retireJourney,
  startBootstrap,
  startJourneySignIn,
  verifyJourneySession,
  type JourneyRuntime,
} from './invitation-journey-operations';
import type { InvitationSignInMethod } from './model/sign-in-method';
import {
  CLEANUP_UNFINISHED,
  NOT_SET_ASIDE,
  type AcceptanceFailure,
} from './model/acceptance-failure';

/**
 * The acceptance journey for one mounted page. The link token is read once,
 * the fragment is cleared, and every late answer is ignored once StrictMode,
 * unmounting or a newer invitation link has taken over.
 */
export function useInvitationJourney({
  apiClient,
  routeToken,
  signInMethod,
  clearFragment,
  navigateToProvider,
  openSignIn,
  openFreshSignIn,
  openWorkspace,
  openWorkspaceDiscovery,
}: Readonly<{
  apiClient: ApiClient;
  routeToken: string | undefined;
  signInMethod: InvitationSignInMethod;
  clearFragment: () => void;
  navigateToProvider: (url: string) => void;
  /** Sign in, then come back to this invitation. */
  openSignIn: () => void;
  /** Sign out and in again with a fresh session, then come back. */
  openFreshSignIn: () => void;
  openWorkspace: (workspaceId: string) => void;
  openWorkspaceDiscovery: () => void;
}>) {
  const [journey, setJourney] = useState<InvitationAcceptanceJourney>();
  const [error, setError] = useState<AcceptanceFailure>();
  const [pending, setPending] = useState(false);
  const [initialToken] = useState(routeToken);
  const [tokenAvailable, setTokenAvailable] = useState(
    initialToken !== undefined,
  );
  const token = useRef<string | undefined>(initialToken);
  const observedRouteToken = useRef(routeToken);
  const started = useRef(false);
  const lifecycle = useRef(0);
  const ownership = useRef(1);
  const bootstrapController = useRef<AbortController | undefined>(undefined);
  const oidcController = useRef<AbortController | undefined>(undefined);
  const cleanupController = useRef<AbortController | undefined>(undefined);
  const completion = useRef<JourneyRuntime['completion']['current']>(undefined);
  const runtime = useMemo<JourneyRuntime>(
    () => ({
      apiClient,
      token,
      lifecycle,
      ownership,
      bootstrapController,
      oidcController,
      cleanupController,
      completion,
      setJourney,
      setError,
      setPending,
      setTokenAvailable,
    }),
    [apiClient],
  );

  const bootstrap = useCallback(
    (owned = ownership.current) => {
      startBootstrap(runtime, owned, signInMethod === 'session');
    },
    [runtime, signInMethod],
  );

  useEffect(() => {
    const generation = ++lifecycle.current;
    if (!started.current) {
      started.current = true;
      if (initialToken !== undefined) clearFragment();
      bootstrap();
    }
    return () => {
      // A StrictMode replay runs the effect again before this microtask, so
      // only a real unmount retires the journey.
      queueMicrotask(() => {
        if (runtime.lifecycle.current === generation) retireJourney(runtime);
      });
    };
  }, [bootstrap, clearFragment, initialToken, runtime]);

  useEffect(() => {
    const previous = observedRouteToken.current;
    observedRouteToken.current = routeToken;
    if (routeToken === undefined || routeToken === previous) return;
    // A newer invitation link on the mounted route takes over the journey.
    const owned = ++ownership.current;
    bootstrapController.current?.abort();
    oidcController.current?.abort();
    cleanupController.current?.abort();
    completion.current = undefined;
    token.current = routeToken;
    setTokenAvailable(true);
    setJourney(undefined);
    setError(undefined);
    setPending(false);
    clearFragment();
    bootstrap(owned);
  }, [bootstrap, clearFragment, routeToken]);

  return {
    journey,
    error,
    pending,
    tokenAvailable,
    retry: () => {
      bootstrap();
    },
    signIn: () =>
      void (signInMethod === 'session'
        ? verifyJourneySession(runtime, journey, {
            signIn: openSignIn,
            signInAgain: openFreshSignIn,
          })
        : startJourneySignIn(runtime, journey, navigateToProvider)),
    /** A different account is signed in: sign in again as the invited one. */
    switchAccount: () => {
      if (signInMethod === 'session') openFreshSignIn();
      else void startJourneySignIn(runtime, journey, navigateToProvider);
    },
    accept: () => void acceptJourney(runtime, journey),
    reconcile: () => void reconcileJourney(runtime),
    /** After completion: clear the binding, then open the workspace. */
    openCompleted: (workspaceId: string, csrfToken: string) =>
      void leaveJourney(runtime, csrfToken, CLEANUP_UNFINISHED, () => {
        openWorkspace(workspaceId);
      }),
    /** "Not now": clear the binding and go to the person's workspaces. */
    setAside: () => {
      if (journey === undefined || journey.state === 'unavailable') {
        openWorkspaceDiscovery();
        return;
      }
      void leaveJourney(
        runtime,
        journey.csrfToken,
        NOT_SET_ASIDE,
        openWorkspaceDiscovery,
      );
    },
  };
}
