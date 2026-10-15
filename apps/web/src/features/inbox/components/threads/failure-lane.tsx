import type { WorkspaceInboxFailureThread } from '@pertexo/contracts';
import { cn } from '@/lib/utils';

const DAY_MILLIS = 86_400_000;

/**
 * The workflow's last 30 days as one thread, today at the right: a cross
 * snags it on each day it failed, the latest one larger, with the count
 * above a day that failed more than once.
 */
export function FailureLane({
  days,
  nowMs,
  unread = false,
}: Readonly<{
  days: WorkspaceInboxFailureThread['failureDays'];
  nowMs: number;
  /** An unread notice's thread reads a little brighter. */
  unread?: boolean;
}>) {
  const today = Math.floor(nowMs / DAY_MILLIS) * DAY_MILLIS;
  const counts = new Map(days.map(({ day, count }) => [day, count]));
  const marks = Array.from({ length: 30 }, (_, index) => {
    const day = new Date(today - (29 - index) * DAY_MILLIS)
      .toISOString()
      .slice(0, 10);
    return { day, count: counts.get(day) ?? 0 };
  });
  const total = marks.reduce((sum, mark) => sum + mark.count, 0);
  const latest = marks.reduce(
    (found, mark, index) => (mark.count > 0 ? index : found),
    -1,
  );
  return (
    <figure
      className="mt-2 w-full"
      aria-label={`${String(total)} ${total === 1 ? 'failure' : 'failures'} in the last 30 days`}
    >
      <div className="relative flex items-center" aria-hidden="true">
        <span
          className={cn(
            'absolute inset-x-0 h-px',
            unread ? 'bg-white/18' : 'bg-border',
          )}
        />
        {marks.map(({ day, count }, index) => (
          <span
            key={day}
            className="relative flex h-6 min-w-0 flex-1 items-center justify-center"
            title={`${day} UTC: ${String(count)} ${count === 1 ? 'failure' : 'failures'}`}
          >
            {count > 1 ? (
              <span className="absolute -top-1.5 font-mono text-[0.58rem] leading-none text-destructive/80">
                {count > 99 ? '99+' : count}
              </span>
            ) : null}
            {count > 0 ? (
              // Weft's failure cross: the thread is snagged here.
              <svg
                viewBox="8.5 4 8 8"
                className={cn(
                  'relative bg-background text-destructive',
                  index === latest
                    ? 'size-3 drop-shadow-[0_0_5px_var(--destructive)]'
                    : 'size-2 opacity-80',
                )}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              >
                <path d="M9.5 5l6 6M15.5 5l-6 6" />
              </svg>
            ) : null}
          </span>
        ))}
        {/* Now: where the thread has reached. */}
        <span className="relative ml-1 size-1.5 shrink-0 rounded-full bg-subtle-foreground" />
      </div>
      <span className="sr-only">
        Failure days:{' '}
        {marks
          .filter((mark) => mark.count > 0)
          .map(
            (mark) =>
              `${mark.day} UTC, ${String(mark.count)} ${mark.count === 1 ? 'failure' : 'failures'}`,
          )
          .join('; ') || 'none'}
        .
      </span>
      <figcaption className="mt-0.5 flex justify-between gap-3 font-mono text-[0.6rem] text-subtle-foreground">
        <span>30 days ago</span>
        <span>Today</span>
      </figcaption>
    </figure>
  );
}
