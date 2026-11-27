import { CheckIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import {
  StatusMark,
  type StatusTone,
} from '@/components/patterns/status/status-mark';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { formatDateTime, formatElapsedTime } from '@/lib/format/time';
import { cn } from '@/lib/class-names';

/**
 * One notice, whatever its kind: a ring lit while unread, the title with its
 * status word and time on one line, one summary line, and on the right what
 * it shows at a glance and its actions. Every kind shares this frame, so the
 * list keeps one rhythm and one inset divider between rows.
 */
export function NoticeFrame({
  unread,
  title,
  occurredAt,
  nowMs,
  summary,
  aside,
  actions,
  status,
}: Readonly<{
  unread: boolean;
  /** The link that opens the notice. */
  title: ReactNode;
  occurredAt: string;
  nowMs: number;
  summary?: ReactNode;
  aside?: ReactNode;
  actions?: ReactNode;
  status: Readonly<{ tone: StatusTone; word: string }>;
}>) {
  const { tone, word } = status;

  return (
    <li
      data-slot="inbox-thread"
      data-unread={unread ? true : undefined}
      className="group/row row-divider grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-4 gap-y-2 rounded-lg px-3 py-3 transition-colors hover:bg-select motion-reduce:transition-none sm:grid-cols-[2rem_minmax(0,1fr)_auto]"
    >
      <span
        aria-hidden="true"
        className={cn(
          'grid size-8 place-items-center rounded-sm transition-colors',
          unread ? 'bg-select-raised' : 'opacity-80',
        )}
      >
        <StatusMark display="mark" tone={tone} />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 sm:flex-nowrap">
          {title}
          {/* The ring already draws the glyph; the word keeps its colour. */}
          <span className="shrink-0 text-label font-medium text-muted-foreground">
            {word}
          </span>
          <time
            dateTime={occurredAt}
            title={formatDateTime(occurredAt)}
            className="shrink-0 font-mono text-xs text-subtle-foreground"
          >
            {formatElapsedTime(occurredAt, nowMs)}
          </time>
        </div>
        {summary === undefined ? null : (
          <div className="line-clamp-2 min-w-0 text-sm text-muted-foreground xl:line-clamp-1">
            {summary}
          </div>
        )}
      </div>
      {/* Under the notice on a phone, beside it on wider screens. A narrow
          phone wraps the actions under the lane rather than past the edge. */}
      <div className="relative z-10 col-start-2 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 sm:col-start-3 sm:row-start-1 sm:flex-nowrap sm:justify-start">
        {aside}
        {actions === undefined ? null : (
          <div className="flex items-center">{actions}</div>
        )}
      </div>
    </li>
  );
}

/**
 * A row action as an icon with its word in a tooltip. `name` is the full
 * accessible name ("Mark Nightly import read"); `render` is the link or
 * button it acts through.
 */
export function NoticeAction({
  label,
  name,
  render,
  children,
}: Readonly<{
  label: string;
  name: string;
  render: ReactElement;
  children: ReactNode;
}>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={render}
        aria-label={name}
        className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Mark read. The button goes once the notice is read, so focus moves to the
 * notice's own link, which stays, instead of falling to the page.
 */
export function MarkReadAction({
  title,
  marking,
  onRead,
}: Readonly<{ title: string; marking: boolean; onRead: () => void }>) {
  return (
    <NoticeAction
      label="Mark read"
      name={`Mark ${title} read`}
      render={
        <button
          type="button"
          disabled={marking}
          onClick={(event) => {
            event.currentTarget
              .closest('li')
              ?.querySelector<HTMLElement>('a[href]')
              ?.focus();
            onRead();
          }}
        />
      }
    >
      <CheckIcon aria-hidden="true" />
    </NoticeAction>
  );
}
