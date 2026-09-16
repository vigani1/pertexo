import type { WorkspaceLifecycleOperationResponse } from '@pertexo/contracts/schemas/identity-workspace';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const labels = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
} as const;

export function WorkspaceLifecycleOperation({
  operation,
  loading,
  readError,
  onRetryRead,
  onDismiss,
}: Readonly<{
  operation?: WorkspaceLifecycleOperationResponse;
  loading: boolean;
  readError: boolean;
  onRetryRead: () => void;
  onDismiss: () => void;
}>) {
  if (loading && operation === undefined)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading lifecycle operation…
      </p>
    );
  if (readError && operation === undefined)
    return (
      <div>
        <p role="alert" className="text-sm text-destructive">
          The lifecycle operation could not be loaded.
        </p>
        <Button
          className="mt-3"
          type="button"
          variant="outline"
          onClick={onRetryRead}
        >
          Try again
        </Button>
      </div>
    );
  if (operation === undefined) return null;

  const terminal =
    operation.status === 'completed' || operation.status === 'failed';
  return (
    <div
      className="rounded-lg border border-border bg-background/35 p-4"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">
            {operation.commandType === 'deletion_requested'
              ? 'Deletion request'
              : 'Workspace restore'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Operation {operation.id}
          </p>
        </div>
        <Badge
          variant={
            operation.status === 'failed'
              ? 'destructive'
              : operation.status === 'completed'
                ? 'secondary'
                : 'muted'
          }
        >
          {labels[operation.status]}
        </Badge>
      </div>
      {!terminal ? (
        <p className="mt-3 text-sm text-muted-foreground">
          The command was accepted, but the workspace change is not complete
          yet.
        </p>
      ) : null}
      {operation.status === 'failed' ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          The operation failed
          {operation.errorCode === null ? '.' : ` (${operation.errorCode}).`}
        </p>
      ) : null}
      {readError ? (
        <div className="mt-3">
          <p role="alert" className="text-sm text-destructive">
            The latest operation status could not be loaded. The last known
            state remains visible.
          </p>
          <Button
            className="mt-3"
            type="button"
            variant="outline"
            onClick={onRetryRead}
          >
            Retry status
          </Button>
        </div>
      ) : null}
      {terminal ? (
        <Button
          className="mt-4"
          type="button"
          variant="ghost"
          onClick={onDismiss}
        >
          Dismiss operation
        </Button>
      ) : null}
    </div>
  );
}
