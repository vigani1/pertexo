import { useRef } from 'react';
import type { FailureNotificationDestinationResponse } from '@pertexo/contracts/schemas/failure-notifications';
import { Button } from '@/components/ui/button';
import { StatusGlyph } from '@/components/ui/status';
import { Switch } from '@/components/ui/switch';
import { useNotifications } from '@/components/ui/use-notifications';
import { isUncertainOutcome } from '@/lib/api/api-error-copy';
import { destinationCommandError } from '../failure-notification-errors';
import {
  useSetFailureNotificationDestinationStatusMutation,
  type DestinationMutationScope,
} from '../failure-notifications.mutations';

type DestinationStatus = FailureNotificationDestinationResponse['status'];
type StatusCommand = Readonly<{
  status: DestinationStatus;
  idempotencyKey: string;
}>;

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
  const attempt = useRef<StatusCommand | undefined>(undefined);

  function send(command: StatusCommand) {
    attempt.current = command;
    mutation.mutate(
      { destinationId, ...command },
      {
        onSuccess: (destination) => {
          attempt.current = undefined;
          notifications.success({
            title: `Alerts to ${label} turned ${destination.status === 'enabled' ? 'on' : 'off'}`,
          });
        },
      },
    );
  }

  const uncertain = mutation.isError && isUncertainOutcome(mutation.error);
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
            send({
              status: checked ? 'enabled' : 'disabled',
              idempotencyKey: crypto.randomUUID(),
            });
          }}
        />
      </div>
      {mutation.isError ? (
        <div
          role="alert"
          className="flex max-w-80 items-start gap-2 text-right text-xs text-foreground"
        >
          <StatusGlyph
            tone={uncertain ? 'attention' : 'failure'}
            className={uncertain ? 'text-warning' : 'text-destructive'}
          />
          <span>
            {destinationCommandError(
              mutation.error,
              mutation.variables.status === 'enabled' ? 'enable' : 'disable',
            )}
          </span>
          {uncertain ? (
            <Button
              type="button"
              size="xs"
              variant="default"
              onClick={() => {
                const command = attempt.current;
                if (command !== undefined) send(command);
              }}
            >
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
