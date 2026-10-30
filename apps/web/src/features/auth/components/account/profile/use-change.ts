import {
  RETRY_WINDOW_ENDED,
  canResend,
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from '@/lib/api/commands/contract';
import type { UserProfileResponse } from '@pertexo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { isApiError } from '@/lib/api/error';
import type { ApiClient } from '@/lib/api/client';
import { updateCurrentUserProfile } from '../../../data/auth.api';
import { currentUserQueryKey } from '../../../data/auth.queries';
import { accountCommandFailure } from '../../../model/account/failure';

type NameAttempt = Readonly<{
  displayName: string;
  expectedRevision: number;
}> &
  CommandKey;
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
      if (isUnconfirmedCommand(cause)) {
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
    conflict: state.kind === 'idle' && (state.conflict ?? false),
    failure: state.kind === 'idle' ? state.failure : undefined,
    save: (displayName: string, expectedRevision: number) => {
      if (state.kind !== 'idle') return;
      void send({
        displayName,
        expectedRevision,
        ...newCommandKey(),
      });
    },
    /** Sends the unconfirmed command again, exactly, within its window. */
    retry: () => {
      if (state.kind !== 'unconfirmed') return;
      if (canResend(state.attempt)) void send(state.attempt);
      else setState({ kind: 'idle', failure: RETRY_WINDOW_ENDED });
    },
    /** Gives up on an unconfirmed change and reloads the real name. */
    dismiss: () => {
      setState({ kind: 'idle' });
      void queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
    },
  };
}
