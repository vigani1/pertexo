import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { destinationCommandErrorMessage } from '../failure-notification-errors';
import { useSetFailureNotificationDestinationStatusMutation } from '../failure-notifications.mutations';

export function DestinationStatusButton({
  apiClient,
  userId,
  workspaceId,
  destinationId,
  currentStatus,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  destinationId: string;
  currentStatus: 'enabled' | 'disabled';
}>) {
  const mutation = useSetFailureNotificationDestinationStatusMutation({
    apiClient,
    userId,
    workspaceId,
  });
  const attempt = useRef<
    | {
        status: 'enabled' | 'disabled';
        idempotencyKey: string;
      }
    | undefined
  >(undefined);
  const nextStatus: 'enabled' | 'disabled' =
    currentStatus === 'enabled' ? 'disabled' : 'enabled';

  function updateStatus() {
    const command =
      mutation.isError && attempt.current !== undefined
        ? attempt.current
        : { status: nextStatus, idempotencyKey: crypto.randomUUID() };
    attempt.current = command;
    mutation.mutate(
      { destinationId, ...command },
      {
        onSuccess: () => {
          attempt.current = undefined;
        },
      },
    );
  }

  return (
    <div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={mutation.isPending}
        onClick={updateStatus}
      >
        {mutation.isPending
          ? 'Updating…'
          : mutation.isError
            ? 'Retry safely'
            : nextStatus === 'enabled'
              ? 'Enable'
              : 'Disable'}
      </Button>
      {mutation.isError ? (
        <p role="alert" className="mt-2 max-w-72 text-sm text-destructive">
          {destinationCommandErrorMessage(
            mutation.error,
            `${mutation.variables.status === 'enabled' ? 'enable' : 'disable'} this destination`,
          )}
        </p>
      ) : null}
    </div>
  );
}
