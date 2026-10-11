import type { WorkspaceInboxThread } from '@pertexo/contracts';

const DAY_MILLIS = 86_400_000;

export function FailureLane({
  days,
  nowMs,
}: Readonly<{ days: WorkspaceInboxThread['failureDays']; nowMs: number }>) {
  const today = Math.floor(nowMs / DAY_MILLIS) * DAY_MILLIS;
  const counts = new Map(days.map(({ day, count }) => [day, count]));
  const marks = Array.from({ length: 30 }, (_, index) => {
    const day = new Date(today - (29 - index) * DAY_MILLIS)
      .toISOString()
      .slice(0, 10);
    return { day, count: counts.get(day) ?? 0 };
  });
  const total = marks.reduce((sum, mark) => sum + mark.count, 0);
  return (
    <figure
      className="mt-2 max-w-80"
      aria-label={`${String(total)} retained failures in the last 30 days, by UTC day`}
    >
      <div className="flex items-center" aria-hidden="true">
        {marks.map(({ day, count }) => (
          <span
            key={day}
            className="relative flex h-5 min-w-0 flex-1 items-center justify-center"
            title={`${day} UTC: ${String(count)} ${count === 1 ? 'failure' : 'failures'}`}
          >
            <span
              aria-hidden="true"
              className="absolute inset-x-0 h-px bg-border"
            />
            {count > 0 ? (
              <span
                aria-hidden="true"
                className="relative font-mono text-sm text-destructive"
              >
                ×
              </span>
            ) : null}
          </span>
        ))}
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
      <figcaption className="mt-1 flex justify-between gap-3 font-mono text-[0.6rem] text-subtle-foreground">
        <span>30 days · retained failures</span>
        <span>today UTC</span>
      </figcaption>
    </figure>
  );
}
