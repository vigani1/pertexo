import type { WorkspaceInboxFailureThread } from '@pertexo/contracts';
import { cn } from '@/lib/utils';

const DAY_MILLIS = 86_400_000;
const DAYS = 30;

/** How strongly a day glows: one failure is a mark, many a bright bar. */
function intensity(count: number): string {
  if (count === 0) return 'bg-white/[0.07]';
  if (count === 1) return 'bg-destructive/45';
  if (count <= 3) return 'bg-destructive/70';
  return 'bg-destructive shadow-[0_0_6px_-1px_var(--destructive)]';
}

/**
 * The workflow's last 30 days as one compact strip, today at the right: a
 * bar per day, red where runs failed and brighter the more did, so where a
 * failure streak starts and stops reads at a glance. The words around it
 * say since when and how many; each bar names its day on hover.
 */
export function FailureLane({
  days,
  nowMs,
  className,
}: Readonly<{
  days: WorkspaceInboxFailureThread['failureDays'];
  nowMs: number;
  className?: string;
}>) {
  const today = Math.floor(nowMs / DAY_MILLIS) * DAY_MILLIS;
  const counts = new Map(days.map(({ day, count }) => [day, count]));
  const marks = Array.from({ length: DAYS }, (_, index) => {
    const day = new Date(today - (DAYS - 1 - index) * DAY_MILLIS)
      .toISOString()
      .slice(0, 10);
    return { day, count: counts.get(day) ?? 0 };
  });
  const failing = marks.filter((mark) => mark.count > 0);
  const total = failing.reduce((sum, mark) => sum + mark.count, 0);
  return (
    <figure
      className={cn('flex items-center gap-2', className)}
      aria-label={`${String(total)} ${total === 1 ? 'failure' : 'failures'} in the last 30 days`}
    >
      <span
        aria-hidden="true"
        className="font-mono text-[0.6rem] text-subtle-foreground"
      >
        30d
      </span>
      <div aria-hidden="true" className="flex items-end gap-px">
        {marks.map(({ day, count }, index) => (
          <span
            key={day}
            title={`${day} UTC: ${String(count)} ${count === 1 ? 'failure' : 'failures'}`}
            className={cn(
              'w-[5px] rounded-[1.5px]',
              count === 0 ? 'h-2.5' : 'h-4',
              intensity(count),
              // Today: where the strip has reached.
              index === DAYS - 1 &&
                'outline outline-1 outline-offset-1 outline-white/25',
            )}
          />
        ))}
      </div>
      <span className="sr-only">
        Failure days:{' '}
        {failing
          .map(
            (mark) =>
              `${mark.day} UTC, ${String(mark.count)} ${mark.count === 1 ? 'failure' : 'failures'}`,
          )
          .join('; ') || 'none'}
        .
      </span>
    </figure>
  );
}
