import type { WorkspaceInboxThread } from '@pertexo/contracts/schemas/workspace-inbox';
import { Link } from '@tanstack/react-router';
import { Status } from '@/components/ui/status';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { formatDateTime, formatRelativeTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import { describeInboxThread } from '../model/inbox-thread';

/**
 * One failing workflow: its latest failure, how often it has failed and where.
 * The whole row opens the latest run and marks the notice read; run history
 * and "Mark read" sit above that link.
 */
export function InboxThreadRow({
  workspaceId,
  thread,
  nowMs,
  marking,
  onRead,
}: Readonly<{
  workspaceId: string;
  thread: WorkspaceInboxThread;
  nowMs: number;
  marking: boolean;
  onRead: () => void;
}>) {
  const view = describeInboxThread(thread);
  return (
    <li
      data-slot="inbox-thread"
      className="group/row relative grid grid-cols-[0.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1 rounded-md px-3 py-3 transition-colors hover:bg-white/[0.035] sm:grid-cols-[0.5rem_minmax(0,1fr)_auto]"
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-2 size-2 rounded-full',
          thread.unread
            ? 'bg-action shadow-[0_0_0_3px_color-mix(in_srgb,var(--action)_18%,transparent)]'
            : 'bg-transparent',
        )}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <Link
            to="/w/$workspaceId/runs/$runId"
            params={{ workspaceId, runId: thread.latestRunId }}
            onClick={onRead}
            {...(thread.unread
              ? { 'aria-label': `${thread.workflowName}, unread` }
              : {})}
            className={cn(
              "min-w-0 truncate outline-none after:absolute after:inset-0 after:rounded-md after:content-[''] hover:text-accent-foreground focus-visible:after:ring-2 focus-visible:after:ring-ring/60",
              thread.unread
                ? 'font-semibold text-foreground'
                : 'font-medium text-muted-foreground',
            )}
          >
            {thread.workflowName}
          </Link>
          <Status tone={view.look.tone}>{view.look.label}</Status>
          <time
            dateTime={thread.latestOccurredAt}
            title={formatDateTime(thread.latestOccurredAt)}
            className="font-mono text-xs text-subtle-foreground"
          >
            {formatRelativeTime(thread.latestOccurredAt, nowMs)}
          </time>
        </div>
        <p className="min-w-0 text-xs text-muted-foreground">
          {view.occurrences}
          {view.step === undefined ? null : (
            <>
              {' · at '}
              <span className="text-foreground">{view.step}</span>
            </>
          )}
          {view.reason === undefined ? null : ` · ${view.reason}`}
        </p>
      </div>
      {/* Below the notice on a phone, beside it on wider screens. */}
      <div className="relative z-10 col-start-2 -ml-2.5 flex items-center gap-1 sm:col-start-3 sm:row-start-1 sm:ml-0 sm:self-center">
        <Link
          to="/w/$workspaceId/workflows/$workflowId/runs"
          params={{ workspaceId, workflowId: thread.workflowId }}
          aria-label={`Run history of ${thread.workflowName}`}
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          Run history
        </Link>
        {thread.unread ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={marking}
            aria-label={`Mark ${thread.workflowName} read`}
            onClick={onRead}
          >
            Mark read
          </Button>
        ) : null}
      </div>
    </li>
  );
}
