import type { WorkspaceLifecycleOperationResponse } from '@pertexo/contracts/schemas/identity-workspace';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Notice } from '@/components/ui/notice';
import { Status, type StatusTone } from '@/components/ui/status';
import { formatDateTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';

type Operation = WorkspaceLifecycleOperationResponse;

const STATUS: Readonly<
  Record<Operation['status'], Readonly<{ tone: StatusTone; label: string }>>
> = {
  pending: { tone: 'queued', label: 'Queued' },
  running: { tone: 'live', label: 'Running' },
  completed: { tone: 'success', label: 'Done' },
  failed: { tone: 'failure', label: 'Failed' },
};

function sentence(operation: Operation): string {
  const deleting = operation.commandType === 'deletion_requested';
  switch (operation.status) {
    case 'pending':
    case 'running':
      return deleting
        ? 'Pertexo is stopping access and triggers. This updates on its own.'
        : 'Pertexo is bringing the workspace back. This updates on its own.';
    case 'completed':
      return deleting
        ? 'The workspace is scheduled for deletion. Restore it within 30 days of the request to keep it.'
        : 'The workspace is back, suspended. Triggers and integrations stay off until you reconnect them.';
    case 'failed':
      return deleting
        ? 'The deletion didn’t finish, so nothing changed.'
        : 'The restore didn’t finish, so the workspace is still scheduled for deletion.';
  }
}

/**
 * A lifecycle request on its way: the live edge runs while it is in flight;
 * raw identifiers stay in Details for support.
 */
export function WorkspaceLifecycleOperation({
  operation,
  loading,
  readError,
  onRetryRead,
  onDismiss,
}: Readonly<{
  operation: Operation | undefined;
  loading: boolean;
  readError: boolean;
  onRetryRead: () => void;
  onDismiss: () => void;
}>) {
  if (loading && operation === undefined)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading the latest request…
      </p>
    );
  if (readError && operation === undefined)
    return (
      <Notice
        tone="destructive"
        action={
          <Button type="button" size="xs" variant="ghost" onClick={onRetryRead}>
            Try again
          </Button>
        }
      >
        The latest request couldn’t be loaded.
      </Notice>
    );
  if (operation === undefined) return null;

  const status = STATUS[operation.status];
  const inFlight =
    operation.status === 'pending' || operation.status === 'running';
  return (
    <section
      aria-live="polite"
      aria-label={
        operation.commandType === 'deletion_requested'
          ? 'Deletion request'
          : 'Restore request'
      }
      className={cn(
        'flex flex-col gap-3 rounded-lg border border-border bg-background/40 p-4',
        inFlight && 'live-edge',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-semibold">
          {operation.commandType === 'deletion_requested'
            ? 'Deleting the workspace'
            : 'Restoring the workspace'}
        </p>
        <Status tone={status.tone}>{status.label}</Status>
      </div>
      <p
        role={operation.status === 'failed' ? 'alert' : undefined}
        className="text-sm text-muted-foreground"
      >
        {sentence(operation)}
      </p>
      {readError ? (
        <Notice
          role="alert"
          tone="warning"
          action={
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={onRetryRead}
            >
              Try again
            </Button>
          }
        >
          The latest status couldn’t be loaded; this is the last one we saw.
        </Notice>
      ) : null}
      <details className="text-xs text-subtle-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">
          Details
        </summary>
        <dl className="mt-2 grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 font-mono">
          <dt>Request</dt>
          <dd>
            <CopyButton
              value={operation.id}
              label="Copy request ID"
              display={`${operation.id.slice(0, 4)}…${operation.id.slice(-3)}`}
            />
          </dd>
          <dt>Submitted</dt>
          <dd>{formatDateTime(operation.submittedAt)}</dd>
          {operation.errorCode === null ? null : (
            <>
              <dt>Error code</dt>
              <dd>{operation.errorCode}</dd>
            </>
          )}
        </dl>
      </details>
      {inFlight ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      )}
    </section>
  );
}
