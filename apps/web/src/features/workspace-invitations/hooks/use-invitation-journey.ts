import type { InvitationAcceptanceJourney } from '@pertexo/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import {
  acceptJourney,
  leaveJourney,
  reconcileJourney,
  retireJourney,
  startBootstrap,
  verifyJourneySession,
  type JourneyRuntime,
} from '../model/invitation-journey-operations';
import {
  CLEANUP_UNFINISHED,
  NOT_SET_ASIDE,
  type AcceptanceFailure,
} from '../model/acceptance-failure';

/**
 * The acceptance journey for one invitation link. The link token is read
 * into memory, the fragment is cleared, and cleanup cancels outstanding
 * reads and invalidates late command answers. A newer link is a new journey:
 * the page keys this one by its link, so it retires as it unmounts.
 */
export function useInvitationJourney({
  apiClient,
  routeToken,
  clearFragment,
  openSignIn,
  openFreshSignIn,
  openWorkspace,
  openWorkspaceDiscovery,
}: Readonly<{
  apiClient: ApiClient;
  routeToken: string | undefined;
  clearFragment: () => void;
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
  const ownership = useRef(1);
  const bootstrapController = useRef<AbortController | undefined>(undefined);
  const verifyController = useRef<AbortController | undefined>(undefined);
  const cleanupController = useRef<AbortController | undefined>(undefined);
  const completion = useRef<JourneyRuntime['completion']['current']>(undefined);
  const runtime = useMemo<JourneyRuntime>(
    () => ({
      apiClient,
      token,
      ownership,
      bootstrapController,
      verifyController,
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
      startBootstrap(runtime, owned);
    },
    [runtime],
  );

  useEffect(() => {
    if (initialToken !== undefined) clearFragment();
    bootstrap();
    return () => {
      retireJourney(runtime);
    };
  }, [bootstrap, clearFragment, initialToken, runtime]);

  return {
    journey,
    error,
    pending,
    tokenAvailable,
    retry: () => {
      bootstrap();
    },
    signIn: () =>
      void verifyJourneySession(runtime, journey, {
        signIn: openSignIn,
        signInAgain: openFreshSignIn,
      }),
    /** A different account is signed in: sign in again as the invited one. */
    switchAccount: openFreshSignIn,
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
