import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Status } from '@/components/ui/status';
import { isApiError } from '@/lib/api/error';
type CommandFeedback = Readonly<{
  error: string | undefined;
  cause: unknown;
  uncertain: boolean;
  pending: boolean;
  expired: boolean;
  retry: () => void;
}>;
export function VariableEditorFeedback({
  baseRevision,
  serverChanged,
  error,
  command,
}: Readonly<{
  baseRevision: number;
  serverChanged: boolean;
  error: string | undefined;
  command: CommandFeedback;
}>) {
  return (
    <>
      {serverChanged ? (
        <Notice tone="warning">
          The shared set changed. Your draft still uses revision {baseRevision};
          reload the current values before editing again.
        </Notice>
      ) : null}
      {error === undefined ? null : <Notice tone="destructive">{error}</Notice>}
      {command.error === undefined ? null : (
        <Notice
          tone={command.uncertain ? 'warning' : 'destructive'}
          action={recoveryAction(command)}
        >
          {isApiError(command.cause) &&
          command.cause.problem?.code === 'variables.changed'
            ? 'Someone changed the shared values. Your edits are kept; discard them to load the latest values, then save again.'
            : command.error}
        </Notice>
      )}
    </>
  );
}
export function VariableSaveFeedback({
  revision,
}: Readonly<{ revision: number | undefined }>) {
  return revision === undefined ? null : (
    <Status tone="success">Saved revision {revision} for new runs</Status>
  );
}

function recoveryAction(command: CommandFeedback) {
  if (command.expired) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          window.location.reload();
        }}
      >
        Reload page (discard draft)
      </Button>
    );
  }
  if (command.uncertain) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={command.pending}
        onClick={command.retry}
      >
        Retry same save
      </Button>
    );
  }
  return undefined;
}
