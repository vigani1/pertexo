import { FailureLane } from './failure-lane';
import type { WorkspaceInboxFailureThread } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { CheckIcon, HistoryIcon } from 'lucide-react';
import { StatusGlyph } from '@/components/ui/status';
import { statusToneText } from '@/components/ui/status-tone';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { formatDateTime, formatElapsedTime } from '@/lib/format/time';
import { cn } from '@/lib/utils';
import { describeInboxThread } from '../../model/inbox-thread.js';

/**
 * One failing workflow as its last 30 days of thread: a ring holding the
 * failure's glyph (lit while unread), what went wrong, and the thread with a
 * snag on every day it failed. The whole row opens the latest run and marks
 * the notice read; run history and "Mark read" sit above that link.
 */
export function InboxThreadRow({
  workspaceId,
  thread,
  nowMs,
  marking,
  onRead,
}: Readonly<{
  workspaceId: string;
  thread: WorkspaceInboxFailureThread;
  nowMs: number;
  marking: boolean;
  onRead: () => void;
}>) {
  const view = describeInboxThread(thread);
  return (
    <li
      data-slot="inbox-thread"
      data-unread={thread.unread ? true : undefined}
      className="group/row relative grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-x-4 gap-y-1 rounded-lg px-3 py-4 transition-colors before:pointer-events-none before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-border first:before:hidden hover:bg-white/[0.035] hover:before:opacity-0 motion-reduce:transition-none sm:grid-cols-[2rem_minmax(0,1fr)_auto]"
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 grid size-8 place-items-center rounded-full border transition-colors',
          thread.unread
            ? 'border-action/60 bg-action/[0.07] shadow-[0_0_0_4px_color-mix(in_srgb,var(--action)_10%,transparent)]'
            : 'border-border bg-white/[0.02] opacity-70',
        )}
      >
        <StatusGlyph tone={view.look.tone} />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link
            to="/w/$workspaceId/runs/$runId"
            params={{ workspaceId, runId: thread.latestRunId }}
            onClick={onRead}
            {...(thread.unread
              ? { 'aria-label': `${thread.workflowName}, unread` }
              : {})}
            className={cn(
              "min-w-0 truncate outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] hover:text-accent-foreground focus-visible:after:ring-2 focus-visible:after:ring-ring/60",
              thread.unread
                ? 'font-semibold text-foreground'
                : 'font-medium text-muted-foreground',
            )}
          >
            {thread.workflowName}
          </Link>
          {/* The ring already draws the glyph; the word keeps its colour. */}
          <span
            className={cn(
              'text-[0.78rem] font-medium',
              statusToneText[view.look.tone],
            )}
          >
            {view.look.label}
          </span>
          <time
            dateTime={thread.latestOccurredAt}
            title={formatDateTime(thread.latestOccurredAt)}
            className="font-mono text-xs text-subtle-foreground"
          >
            {formatElapsedTime(thread.latestOccurredAt, nowMs)}
          </time>
        </div>
        <p className="min-w-0 text-sm text-muted-foreground">
          {view.occurrences}
          {view.step === undefined ? null : (
            <>
              {' · at '}
              <span className="text-foreground">{view.step}</span>
            </>
          )}
          {view.reason === undefined ? null : ` · ${view.reason}`}
        </p>
        <FailureLane
          days={thread.failureDays}
          nowMs={nowMs}
          unread={thread.unread}
        />
      </div>
      {/* Below the notice on a phone, beside it on wider screens. */}
      <div className="relative z-10 col-start-2 -ml-2.5 flex items-center gap-1 sm:col-start-3 sm:row-start-1 sm:ml-0">
        <Link
          to="/w/$workspaceId/workflows/$workflowId/runs"
          params={{ workspaceId, workflowId: thread.workflowId }}
          aria-label={`Run history of ${thread.workflowName}`}
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          <HistoryIcon data-icon="inline-start" aria-hidden="true" />
          History
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
            <CheckIcon data-icon="inline-start" aria-hidden="true" />
            Mark read
          </Button>
        ) : null}
      </div>
    </li>
  );
}
