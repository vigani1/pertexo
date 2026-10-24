import { isApiError } from '@/lib/api/error';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Status } from '@/components/ui/status';
export function NotificationSaveFeedback({
  error,
  cause,
  uncertain,
  expired,
  pending,
  retry,
  saved,
}: {
  error: string | undefined;
  cause: unknown;
  uncertain: boolean;
  expired: boolean;
  pending: boolean;
  retry: () => void;
  saved: boolean;
}) {
  return (
    <>
      {error === undefined ? null : (
        <Notice
          tone={uncertain ? 'warning' : 'destructive'}
          action={
            uncertain && !expired ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={retry}
              >
                Retry same save
              </Button>
            ) : undefined
          }
        >
          {notificationFailure(cause, error)}
        </Notice>
      )}
      {expired ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">
            Check current settings before starting another request.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              window.location.reload();
            }}
          >
            Reload page and check choices
          </Button>
        </div>
      ) : null}
      {saved ? (
        <Status tone="success">Notification choices saved</Status>
      ) : null}
    </>
  );
}

function notificationFailure(
  cause: unknown,
  fallback: string | undefined,
): string | undefined {
  if (isApiError(cause) && cause.problem?.code === 'notifications.changed')
    return 'Someone changed these notification choices. Your edits are kept; discard them to load the latest choices, then save again.';
  if (isApiError(cause) && cause.problem?.code === 'notifications.unavailable')
    return 'This notification choice is unavailable now. Your edits are kept; reload current choices. Email can always be turned Off.';
  return fallback;
}
