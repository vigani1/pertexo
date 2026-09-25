import {
  formatDateTimeInZone,
  formatRelativeTime,
  localTimeZone,
} from '@/lib/format-time';

/**
 * Upcoming run times on the schedule's own clock and, when that differs, on
 * this person's clock too. An interval has no clock of its own, so it reads
 * in local time. Times come from the server's scheduler (ADR 048).
 */
export function ScheduleRunTimes({
  label,
  times,
  timezone,
}: Readonly<{
  /** Names the list for assistive technology, e.g. "Next runs". */
  label: string;
  times: readonly string[];
  /** The cron rule's IANA timezone; omitted for intervals. */
  timezone?: string;
}>) {
  const local = localTimeZone();
  const zone = timezone ?? local;
  return (
    <ol aria-label={label} className="flex flex-col gap-1.5">
      {times.map((at) => (
        <li
          key={at}
          className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"
        >
          <time dateTime={at} className="font-mono text-sm tabular-nums">
            {formatDateTimeInZone(at, zone)}
          </time>
          <span className="font-mono text-[0.72rem] text-subtle-foreground">
            {zone === local
              ? formatRelativeTime(at)
              : `${formatDateTimeInZone(at, local)} your time · ${formatRelativeTime(at)}`}
          </span>
        </li>
      ))}
    </ol>
  );
}
