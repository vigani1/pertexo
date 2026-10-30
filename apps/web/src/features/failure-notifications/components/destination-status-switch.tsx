import {
  RETRY_WINDOW_ENDED,
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from '@/lib/api/commands/contract';
import { useResendExpired } from '@/lib/api/commands/use-resend-window';
import { useState } from 'react';
import type { FailureNotificationDestinationResponse } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Switch } from '@/components/ui/switch';
import { useNotifications } from '@/components/ui/use-notifications';
import { destinationCommandError } from '../model/failure-notification-errors';
import {
  useSetFailureNotificationDestinationStatusMutation,
  type DestinationMutationScope,
} from '../data/failure-notifications.mutations';

type DestinationStatus = FailureNotificationDestinationResponse['status'];
type StatusCommand = Readonly<{ status: DestinationStatus }> & CommandKey;

/**
 * The Enabled switch. It shows the requested state while saving; an
 * unconfirmed change keeps its key so trying again can't flip twice.
 */
export function DestinationStatusSwitch({
  scope,
  destinationId,
  label,
  status,
  disabled,
}: Readonly<{
  scope: DestinationMutationScope;
  destinationId: string;
  label: string;
  status: DestinationStatus;
  disabled: boolean;
}>) {
  const notifications = useNotifications();
  const mutation = useSetFailureNotificationDestinationStatusMutation(scope);
  // The unconfirmed command a retry resends.
  const [held, setHeld] = useState<StatusCommand>();
  const expired = useResendExpired(held);

  async function send(command: StatusCommand) {
    setHeld(undefined);
    try {
      const destination = await mutation.mutateAsync({
        destinationId,
        ...command,
      });
      notifications.success({
        title: `Alerts to ${label} turned ${destination.status === 'enabled' ? 'on' : 'off'}`,
      });
    } catch (error) {
      // The switch shows the failure and offers the exact retry.
      if (isUnconfirmedCommand(error)) setHeld(command);
    }
  }

  const uncertain = held !== undefined && !expired;
  const requested = mutation.isPending ? mutation.variables.status : status;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span aria-hidden="true" className="max-sm:hidden">
          {requested === 'enabled' ? 'On' : 'Off'}
        </span>
        <Switch
          aria-label={`Send alerts to ${label}`}
          checked={requested === 'enabled'}
          disabled={disabled || mutation.isPending || uncertain}
          onCheckedChange={(checked) => {
            void send({
              status: checked ? 'enabled' : 'disabled',
              ...newCommandKey(),
            });
          }}
        />
      </div>
      {mutation.isError ? (
        <Notice
          role="alert"
          tone={uncertain ? 'warning' : 'destructive'}
          className="max-w-80"
          action={
            uncertain ? (
              <Button
                type="button"
                size="xs"
                variant="default"
                onClick={() => {
                  void send(held);
                }}
              >
                Try again
              </Button>
            ) : undefined
          }
        >
          {expired
            ? RETRY_WINDOW_ENDED
            : destinationCommandError(
                mutation.error,
                mutation.variables.status === 'enabled' ? 'enable' : 'disable',
              )}
        </Notice>
      ) : null}
    </div>
  );
}
