import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  assertSessionIdentity,
  isSessionIdentityChangedError,
  isSessionIdentityUnverifiedError,
} from '@/features/auth/session-identity.public';
import { currentUserQueryOptions } from '@/features/auth/queries.public';
import { subscribeSessionChanges } from '@/features/auth/session-sync.public';
import { isApiError } from '@/lib/api/api-error';
import type { ApiClient } from '@/lib/api/client';

type PauseReason = 'changed' | 'unverified';

export function useEditorSessionVerification({
  apiClient,
  userId,
  workspaceId,
  workflowId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
}>) {
  const [sessionPause, setSessionPause] = useState<PauseReason>();
  const [verificationPending, setVerificationPending] = useState(false);
  const lifecycle = useRef({ paused: false });
  const verificationOwner = useRef<symbol | undefined>(undefined);
  const verificationAbort = useRef<AbortController | undefined>(undefined);
  const queryClient = useQueryClient();
  const currentUser = useQuery(currentUserQueryOptions(apiClient));

  const pauseSession = useCallback((reason: PauseReason) => {
    lifecycle.current.paused = true;
    setSessionPause(reason);
  }, []);

  useEffect(
    () =>
      subscribeSessionChanges(() => {
        pauseSession('unverified');
      }),
    [pauseSession],
  );

  const verifyOwner = useCallback(
    async (signal?: AbortSignal) => {
      try {
        await assertSessionIdentity(apiClient, userId, signal);
      } catch (error) {
        if (
          isSessionIdentityChangedError(error) ||
          (isApiError(error) && error.status === 401)
        )
          pauseSession('changed');
        else if (isSessionIdentityUnverifiedError(error))
          pauseSession('unverified');
        throw error;
      }
    },
    [apiClient, pauseSession, userId],
  );

  const observedIdentityChanged =
    (currentUser.data !== undefined && currentUser.data.id !== userId) ||
    (isApiError(currentUser.error) && currentUser.error.status === 401);
  const pauseReason =
    sessionPause ?? (observedIdentityChanged ? 'changed' : undefined);

  useLayoutEffect(() => {
    const current = lifecycle.current;
    current.paused = pauseReason !== undefined;
    return () => {
      current.paused = true;
    };
  }, [pauseReason]);

  useEffect(() => {
    const owner = Symbol('editor-session-verification');
    verificationOwner.current = owner;
    return () => {
      if (verificationOwner.current === owner) {
        verificationOwner.current = undefined;
        verificationAbort.current?.abort();
        verificationAbort.current = undefined;
      }
    };
  }, [apiClient, userId, workflowId, workspaceId]);

  const verifyOriginalAccount = useCallback(async () => {
    if (verificationAbort.current !== undefined) return;
    const owner = verificationOwner.current;
    if (owner === undefined) return;
    const controller = new AbortController();
    verificationAbort.current = controller;
    setVerificationPending(true);
    try {
      const verifiedUser = await assertSessionIdentity(
        apiClient,
        userId,
        controller.signal,
      );
      if (
        verificationOwner.current !== owner ||
        verificationAbort.current !== controller
      )
        return;
      queryClient.setQueryData(
        currentUserQueryOptions(apiClient).queryKey,
        verifiedUser,
      );
      lifecycle.current.paused = false;
      setSessionPause(undefined);
    } catch (error) {
      if (
        verificationOwner.current !== owner ||
        verificationAbort.current !== controller
      )
        return;
      if (isApiError(error) && error.kind === 'canceled') return;
      pauseSession(
        isSessionIdentityChangedError(error) ||
          (isApiError(error) && error.status === 401)
          ? 'changed'
          : 'unverified',
      );
    } finally {
      if (
        verificationOwner.current === owner &&
        verificationAbort.current === controller
      ) {
        verificationAbort.current = undefined;
        setVerificationPending(false);
      }
    }
  }, [apiClient, pauseSession, queryClient, userId]);

  const isPaused = useCallback(() => lifecycle.current.paused, []);
  return {
    pauseReason,
    verificationPending,
    verifyOwner,
    verifyOriginalAccount,
    isPaused,
  } as const;
}
