import type { UsageTrendPeriod, UsageTrendsResponse } from '@pertexo/contracts';
import { USAGE_TREND_PERIOD_DAYS } from '@pertexo/workflow-model';
import { Link } from '@tanstack/react-router';
import { DayRangePicker } from '@/components/patterns/dates/day-range-picker';
import type { ReadQuery } from '@/components/patterns/states/query-view';
import { shiftDays, type LocalDate } from '@/components/ui/date-time-parts';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { formatCount } from '@/lib/format/count';
import {
  countFailureOutcomes,
  usageInWindow,
  RECENT_USAGE_DAYS,
} from '../model/chart-window';
import { DailyChart } from './trends/daily-chart';
import { UsageSnapshot } from './usage-snapshot';

export type UsageDates = Readonly<{ from: LocalDate; to: LocalDate }>;

type UsageRange = Readonly<{
  period: UsageTrendPeriod;
  recent: boolean;
  dates: UsageDates | undefined;
  onPeriod: (selection: string) => void;
  onDates: (dates: UsageDates | undefined) => void;
}>;

export function UsageRuns({
  workspaceId,
  period,
  recent,
  dates,
  onPeriod,
  onDates,
  trends,
  trendData,
}: UsageRange &
  Readonly<{
    workspaceId: string;
    trends: ReadQuery<UsageTrendsResponse>;
    trendData: UsageTrendsResponse | undefined;
  }>) {
  const firstDay = trendData?.days[0]?.day;
  const lastDay = trendData?.days.at(-1)?.day;
  const bounds =
    firstDay === undefined || lastDay === undefined
      ? undefined
      : { from: firstDay, to: lastDay };
  return (
    <UsageSnapshot
      title="Runs per day"
      description={`Over ${String(recent ? RECENT_USAGE_DAYS : USAGE_TREND_PERIOD_DAYS[period])} UTC days. Today is partial; test runs are left out.`}
      controls={
        <UsageRangeControls
          period={period}
          recent={recent}
          dates={dates}
          bounds={bounds}
          onPeriod={onPeriod}
          onDates={onDates}
        />
      }
      query={trends}
    >
      {(data) => {
        const window =
          recent || dates !== undefined ? usageInWindow(data, dates) : data;
        const failures = countFailureOutcomes(window.byStatus);
        return (
          <div className="flex flex-col gap-4">
            <p className="font-mono text-meta text-muted-foreground">
              {formatCount(window.total, 'run')} · {String(failures)} failed
            </p>
            <DailyChart snapshot={window} appearance="failure-share" />
            <p className="text-meta text-subtle-foreground">
              Red shows runs that failed, timed out or ended with an unknown
              outcome.{' '}
              <Link
                to="/w/$workspaceId/settings/usage/trends"
                params={{ workspaceId: workspaceId }}
                search={{ period: period }}
                className="inline-link"
              >
                Durations and failures by workflow
              </Link>
              {window.byStatus.failed === 0 ||
              window.days.length === 0 ? null : (
                <>
                  {' · '}
                  <Link
                    to="/w/$workspaceId/runs"
                    params={{ workspaceId: workspaceId }}
                    search={{
                      status: 'failed',
                      range: 'custom',
                      createdAtFrom: `${window.days[0]?.day ?? ''}T00:00:00.000Z`,
                      createdAtBefore: `${shiftDays(window.days.at(-1)?.day ?? '', 1)}T00:00:00.000Z`,
                    }}
                    className="inline-link"
                  >
                    View failed runs
                  </Link>
                </>
              )}
            </p>
          </div>
        );
      }}
    </UsageSnapshot>
  );
}

function UsageRangeControls({
  period,
  recent,
  dates,
  bounds,
  onPeriod,
  onDates,
}: UsageRange & Readonly<{ bounds: UsageDates | undefined }>) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToggleGroup
        aria-label="Range"
        value={dates === undefined ? [recent ? 'recent' : period] : []}
        onValueChange={(values) => {
          const choice = values[0];
          if (choice === undefined) return;
          onPeriod(choice);
        }}
      >
        <ToggleGroupItem value="recent">
          {RECENT_USAGE_DAYS} days
        </ToggleGroupItem>
        <ToggleGroupItem value="30d">
          {USAGE_TREND_PERIOD_DAYS['30d']} days
        </ToggleGroupItem>
        <ToggleGroupItem value="90d">
          {USAGE_TREND_PERIOD_DAYS['90d']} days
        </ToggleGroupItem>
      </ToggleGroup>
      {bounds === undefined ? null : (
        <DayRangePicker
          title="Choose dates in UTC"
          label={
            dates === undefined ? 'Choose dates' : `${dates.from} – ${dates.to}`
          }
          initial={dates ?? bounds}
          bounds={bounds}
          presets={[]}
          onApply={(from, to) => {
            if (from < bounds.from || to > bounds.to)
              return 'Choose dates within the selected period.';
            onDates({ from, to });
            return undefined;
          }}
          onClear={() => {
            onDates(undefined);
          }}
        />
      )}
    </div>
  );
}
