import type { UserProfileResponse } from '@pertexo/contracts/schemas/identity-workspace';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { isApiError } from '@/lib/api/api-error';
import { isUncertainOutcome } from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import {
  requestAccountEmailChange,
  revokeAccountSecuritySession,
  revokeOtherAccountSecuritySessions,
  unlinkAccountSecurityMethod,
} from './account-security.api';
import { accountSecurityKeys } from './account-security.queries';
import { updateCurrentUserProfile } from './auth.api';
import { currentUserQueryKey } from './auth.queries';
import { accountCommandFailure } from './model/account-failure';

type NameAttempt = Readonly<{
  displayName: string;
  expectedRevision: number;
  idempotencyKey: string;
}>;
type NameState =
  | Readonly<{ kind: 'idle'; conflict?: boolean; failure?: string }>
  | Readonly<{ kind: 'saving'; attempt: NameAttempt }>
  | Readonly<{ kind: 'unconfirmed'; attempt: NameAttempt }>;

/**
 * Changes the signed-in person's name at the profile revision the edit
 * started from (ADR 043). An unconfirmed change keeps its exact command for a
 * retry; a newer name elsewhere is loaded and the edit stays open.
 */
export function useDisplayNameChange(
  input: Readonly<{
    apiClient: ApiClient;
    onChanged: (profile: UserProfileResponse) => void;
    /** The latest profile was loaded after a newer change elsewhere. */
    onReloaded: () => void;
  }>,
) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<NameState>({ kind: 'idle' });
  const mutation = useMutation({
    mutationFn: (attempt: NameAttempt) =>
      updateCurrentUserProfile(input.apiClient, attempt),
    // The receipt carries the saved profile: it replaces the cached one.
    onSuccess: (receipt) => {
      queryClient.setQueryData(currentUserQueryKey, receipt.profile);
    },
  });

  async function send(attempt: NameAttempt) {
    setState({ kind: 'saving', attempt });
    try {
      const receipt = await mutation.mutateAsync(attempt);
      setState({ kind: 'idle' });
      input.onChanged(receipt.profile);
    } catch (cause) {
      if (isUncertainOutcome(cause)) {
        setState({ kind: 'unconfirmed', attempt });
        return;
      }
      const conflict =
        isApiError(cause) &&
        cause.problem?.code === 'user.profile_revision_conflict';
      if (conflict)
        await queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
      setState({
        kind: 'idle',
        conflict,
        failure: accountCommandFailure(cause, 'changing your name'),
      });
      if (conflict) input.onReloaded();
    }
  }

  return {
    pending: state.kind === 'saving',
    unconfirmed: state.kind === 'unconfirmed',
    conflict: state.kind === 'idle' && state.conflict === true,
    failure: state.kind === 'idle' ? state.failure : undefined,
    save: (displayName: string, expectedRevision: number) => {
      if (state.kind !== 'idle') return;
      void send({
        displayName,
        expectedRevision,
        idempotencyKey: crypto.randomUUID(),
      });
    },
    /** Sends the unconfirmed command again, exactly. */
    retry: () => {
      if (state.kind === 'unconfirmed') void send(state.attempt);
    },
    /** Gives up on an unconfirmed change and reloads the real name. */
    dismiss: () => {
      setState({ kind: 'idle' });
      void queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
    },
  };
}

export function useRevokeAccountSession(apiClient: ApiClient, userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      revokeAccountSecuritySession(apiClient, sessionId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: accountSecurityKeys.sessions(userId),
      }),
  });
}

export function useRevokeOtherAccountSessions(
  apiClient: ApiClient,
  userId: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => revokeOtherAccountSecuritySessions(apiClient),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: accountSecurityKeys.sessions(userId),
      }),
  });
}

export function useUnlinkAccountMethod(apiClient: ApiClient, userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (methodId: string) =>
      unlinkAccountSecurityMethod(apiClient, methodId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: accountSecurityKeys.scope(userId),
      }),
  });
}

/**
 * Asks to change the email. Nothing cached changes yet: the address changes
 * only once the person confirms from both inboxes, which signs them out.
 */
export function useRequestAccountEmailChange(apiClient: ApiClient) {
  return useMutation({
    mutationFn: (newEmail: string) =>
      requestAccountEmailChange(apiClient, newEmail),
  });
}
