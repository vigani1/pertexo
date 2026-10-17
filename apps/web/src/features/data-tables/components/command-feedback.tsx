import { isApiError } from '@/lib/api/error';
import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
export function TableCommandFeedback({
  command,
}: Readonly<{
  command: Readonly<{
    cause?: unknown;
    error: string | undefined;
    uncertain: boolean;
    expired: boolean;
    pending: boolean;
    retry: () => void;
  }>;
}>) {
  return command.error === undefined ? null : (
    <Notice
      tone="warning"
      action={
        command.uncertain ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={command.pending || command.expired}
            onClick={command.retry}
          >
            Retry same action
          </Button>
        ) : undefined
      }
    >
      {isApiError(command.cause) &&
      [400, 409].includes(command.cause.status ?? 0)
        ? (command.cause.problem?.detail ?? command.error)
        : command.error}
    </Notice>
  );
}
