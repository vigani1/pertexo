import { RETRY_WINDOW_ENDED } from '@/lib/api/commands/command-retry';
import type { FailureNotificationDestinationResponse } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Switch } from '@/components/ui/switch';
import { useNotifications } from '@/components/ui/use-notifications';
import { destinationCommandError } from '../model/failure-notification-errors';
import {
  useDestinationStatusChange,
  type DestinationMutationScope,
} from '../data/failure-notifications.mutations';

type DestinationStatus = FailureNotificationDestinationResponse['status'];

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
  const command = useDestinationStatusChange(
    scope,
    destinationId,
    (destination) => {
      notifications.success({
        title: `Alerts to ${label} turned ${destination.status === 'enabled' ? 'on' : 'off'}`,
      });
    },
  );
  const { uncertain, expired } = command;
  const requested = command.requested ?? status;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span aria-hidden="true" className="max-sm:hidden">
          {requested === 'enabled' ? 'On' : 'Off'}
        </span>
        <Switch
          aria-label={`Send alerts to ${label}`}
          checked={requested === 'enabled'}
          disabled={disabled || command.pending || uncertain}
          onCheckedChange={(checked) => {
            command.change(checked ? 'enabled' : 'disabled');
          }}
        />
      </div>
      {command.failure !== undefined ? (
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
                  command.retry();
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
                command.failure,
                command.lastRequested === 'enabled' ? 'enable' : 'disable',
              )}
        </Notice>
      ) : null}
    </div>
  );
}
