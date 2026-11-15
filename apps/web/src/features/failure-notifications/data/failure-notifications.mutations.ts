import { useConnectionResultScope } from '@/features/connections/public';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FailureNotificationDestinationResponse } from '@pertexo/contracts';
import {
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from '@/lib/api/commands/command-retry';
import { useResendExpired } from '@/lib/api/commands/use-resend-window';
import type { ApiClient } from '@/lib/api/client';
import {
  appendFailureNotificationDestinationVersion,
  createFailureNotificationDestination,
  setFailureNotificationDestinationStatus,
  testFailureNotificationDestination,
} from './failure-notifications.api';
import { failureNotificationDestinationKeys } from './failure-notifications.queries';

export type DestinationMutationScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
}>;

/** Create and edit share one key so the page can tell a save is in flight. */
export function destinationEditMutationKey(scope: DestinationMutationScope) {
  return [
    'failure-notification-destinations',
    scope.userId,
    scope.workspaceId,
    'edit',
  ] as const;
}

function useDestinationMutationInvalidation(scope: DestinationMutationScope) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      queryKey: failureNotificationDestinationKeys.scope(
        scope.userId,
        scope.workspaceId,
      ),
    });
}

export function useCreateFailureNotificationDestinationMutation(
  scope: DestinationMutationScope,
) {
  const invalidate = useDestinationMutationInvalidation(scope);
  return useMutation({
    mutationKey: destinationEditMutationKey(scope),
    mutationFn: (
      command: Parameters<typeof createFailureNotificationDestination>[2],
    ) =>
      createFailureNotificationDestination(
        scope.apiClient,
        scope.workspaceId,
        command,
      ),
    onSuccess: invalidate,
  });
}

export function useAppendFailureNotificationDestinationVersionMutation(
  scope: DestinationMutationScope,
) {
  const invalidate = useDestinationMutationInvalidation(scope);
  return useMutation({
    mutationKey: destinationEditMutationKey(scope),
    mutationFn: (
      command: Parameters<
        typeof appendFailureNotificationDestinationVersion
      >[2],
    ) =>
      appendFailureNotificationDestinationVersion(
        scope.apiClient,
        scope.workspaceId,
        command,
      ),
    onSuccess: invalidate,
  });
}

function useSetFailureNotificationDestinationStatusMutation(
  scope: DestinationMutationScope,
) {
  const invalidate = useDestinationMutationInvalidation(scope);
  return useMutation({
    mutationFn: (
      command: Parameters<typeof setFailureNotificationDestinationStatus>[2],
    ) =>
      setFailureNotificationDestinationStatus(
        scope.apiClient,
        scope.workspaceId,
        command,
      ),
    onSuccess: invalidate,
  });
}

export function useTestFailureNotificationDestinationMutation(
  scope: DestinationMutationScope,
) {
  const resultScope = useConnectionResultScope(scope);
  return useMutation({
    onMutate: resultScope,
    onSuccess: (result, _command, owner) => owner.store(result.connection),
    onError: (_error, _command, owner) => owner?.invalidate(),
    mutationKey: [
      'failure-notification-destinations',
      scope.userId,
      scope.workspaceId,
      'test',
    ],
    mutationFn: (
      command: Parameters<typeof testFailureNotificationDestination>[2],
    ) =>
      testFailureNotificationDestination(
        scope.apiClient,
        scope.workspaceId,
        command,
      ),
    retry: false,
  });
}

type DestinationStatus = FailureNotificationDestinationResponse['status'];
type StatusCommand = Readonly<{ status: DestinationStatus }> & CommandKey;

/**
 * Turns a destination's alerts on or off. An unconfirmed change keeps its
 * key so trying again can't flip twice; a new change gets a new key.
 */
export function useDestinationStatusChange(
  scope: DestinationMutationScope,
  destinationId: string,
  onChanged: (destination: FailureNotificationDestinationResponse) => void,
) {
  const mutation = useSetFailureNotificationDestinationStatusMutation(scope);
  // The unconfirmed command a retry resends.
  const [held, setHeld] = useState<StatusCommand>();
  const expired = useResendExpired(held);
  async function send(command: StatusCommand) {
    setHeld(undefined);
    try {
      onChanged(await mutation.mutateAsync({ destinationId, ...command }));
    } catch (error) {
      // The switch shows the failure and offers the exact retry.
      if (isUnconfirmedCommand(error)) setHeld(command);
    }
  }
  return {
    pending: mutation.isPending,
    /** The status asked for while saving. */
    requested: mutation.isPending ? mutation.variables.status : undefined,
    /** What was last asked for, to name the failure. */
    lastRequested: mutation.variables?.status,
    failure: mutation.isError ? mutation.error : undefined,
    uncertain: held !== undefined && !expired,
    expired,
    change(status: DestinationStatus) {
      void send({ status, ...newCommandKey() });
    },
    retry() {
      if (held !== undefined) void send(held);
    },
  };
}
