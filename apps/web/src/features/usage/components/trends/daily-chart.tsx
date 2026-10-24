import { useId } from 'react';
import {
  workflowRunStatusSchema,
  type UsageTrendsResponse,
} from '@pertexo/contracts';
import { Status } from '@/components/ui/status';
import { statusToneText } from '@/components/ui/status-tone';
import { describeRunStatus } from '@/features/workflow-runs/run-labels.public';
import { formatDurationMs } from '@/lib/format/time';
import { FORMAT_LOCALE } from '@/lib/format/locale';
import { Disclosure } from '@/components/ui/disclosure';

function segments(day: UsageTrendsResponse['days'][number], scale: number) {
  let bottom = 176;
  return workflowRunStatusSchema.options.flatMap((status) => {
    const count = day.byStatus[status];
    const end = bottom - count * scale;
    const segment = { status, from: bottom, to: end };
    bottom = end;
    return count === 0 ? [] : [segment];
  });
}
export function DailyChart({
  snapshot,
}: Readonly<{ snapshot: UsageTrendsResponse }>) {
  const title = useId();
  const scale = 156 / Math.max(1, ...snapshot.days.map((day) => day.total));
  return (
    <figure className="min-w-0 max-w-full space-y-4">
      <div role="img" aria-labelledby={title} className="space-y-2">
        <p id={title} className="sr-only">
          Daily runs by outcome, UTC. Exact counts are in Daily data below.
        </p>
        <p className="text-xs text-muted-foreground">
          Peak{' '}
          {Math.max(0, ...snapshot.days.map((day) => day.total)).toLocaleString(
            FORMAT_LOCALE,
          )}{' '}
          runs in a day
        </p>
        <div
          className="grid h-44"
          style={{
            gridTemplateColumns: `repeat(${String(snapshot.days.length)}, minmax(0, 1fr))`,
          }}
        >
          {snapshot.days.map((day) => (
            <svg
              key={day.day}
              aria-hidden="true"
              viewBox="0 0 12 184"
              preserveAspectRatio="none"
              className="h-44 w-full overflow-hidden"
            >
              <title>
                {day.day}: {day.total} runs
              </title>
              <path
                d="M0 176H12"
                stroke="currentColor"
                vectorEffect="non-scaling-stroke"
                className="text-border"
              />
              {segments(day, scale).map((segment) => (
                <path
                  key={segment.status}
                  d={`M6 ${String(segment.from)}V${String(segment.to)}`}
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  className={
                    statusToneText[
                      describeRunStatus({ status: segment.status }).tone
                    ]
                  }
                />
              ))}
            </svg>
          ))}
        </div>
        <div
          aria-hidden="true"
          className="flex justify-between text-[10px] text-muted-foreground"
        >
          {snapshot.days
            .filter(
              (_, index) =>
                index === 0 ||
                index === snapshot.days.length - 1 ||
                index % Math.ceil(snapshot.days.length / 5) === 0,
            )
            .map((day) => (
              <span key={day.day}>{day.day.slice(5)}</span>
            ))}
        </div>
      </div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
        {workflowRunStatusSchema.options
          .filter((status) => snapshot.byStatus[status] > 0)
          .map((status) => (
            <Status key={status} tone={describeRunStatus({ status }).tone}>
              {describeRunStatus({ status }).label}
            </Status>
          ))}
      </figcaption>
      <Disclosure summary="Daily data">
        <div
          className="max-h-96 min-w-0 max-w-full overflow-auto"
          tabIndex={0}
          role="region"
          aria-label="Daily run counts"
        >
          <table className="w-full min-w-[40rem] text-left tabular-nums">
            <caption className="sr-only">
              Daily outcomes and elapsed durations in UTC
            </caption>
            <thead>
              <tr>
                <th scope="col" className="py-2 pr-4 whitespace-nowrap">
                  UTC day
                </th>
                {workflowRunStatusSchema.options.map((status) => (
                  <th key={status} scope="col" className="px-2 py-2">
                    {describeRunStatus({ status }).label}
                  </th>
                ))}
                <th scope="col" className="px-2">
                  Average
                </th>
                <th scope="col" className="px-2">
                  Slowest
                </th>
              </tr>
            </thead>
            <tbody>
              {snapshot.days.map((day) => (
                <tr key={day.day} className="border-t border-border">
                  <th
                    scope="row"
                    className="py-2 pr-4 font-normal whitespace-nowrap"
                  >
                    {day.day}
                  </th>
                  {workflowRunStatusSchema.options.map((status) => (
                    <td key={status} className="px-2">
                      {day.byStatus[status]}
                    </td>
                  ))}
                  <td className="px-2">
                    {formatDurationMs(day.elapsed.averageMs)}
                  </td>
                  <td className="px-2">
                    {formatDurationMs(day.elapsed.slowestMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Disclosure>
    </figure>
  );
}
