import { isWorkspaceBrowsable } from '@/features/workspaces/public';
import { Link } from '@tanstack/react-router';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts';
import { DayRangePicker } from '@/components/patterns/dates/day-range-picker';
import { shiftDays, type LocalDate } from '@/components/ui/date-time-parts';
import { useState } from 'react';
import { formatCount } from '@/lib/format/count';
import {
  countFailureOutcomes,
  usageInWindow,
  RECENT_USAGE_DAYS,
} from '../model/chart-window';
import { useQuery } from '@tanstack/react-query';
import { USAGE_TREND_PERIOD_DAYS } from '@pertexo/workflow-model';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { SettingRow } from '@/components/patterns/settings/row';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { ApiClient } from '@/lib/api/client';
import { formatShortTime } from '@/lib/format/time';
import { CurrentCapacity } from '../components/current-capacity';
import { DailyChart } from '../components/trends/daily-chart';
import { WorkflowRankings } from '../components/trends/rankings';
import { UsageSnapshot } from '../components/usage-snapshot';
import {
  usageCapacityQueryOptions,
  usageTrendsQueryOptions,
} from '../data/usage.queries';
import { isReadAccessLost } from '@/lib/api/read-denial';
import { parseUsageSearch, type UsageSearch } from '../model/usage-search';

/** The older of two snapshot times: the page is only as fresh as that. */
function olderOf(...times: readonly (string | undefined)[]) {
  return times
    .filter((time) => time !== undefined)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}

/**
 * What ran in the workspace and how much room is left: storage and runs at
 * once in two sentences, one chart of runs per day, and the busiest
 * workflows.
 */
export function UsagePage({
  apiClient,
  user,
  workspace,
  search,
  onSearchChange,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  search: UsageSearch;
  onSearchChange: (search: UsageSearch) => void;
}>) {
  const [recent, setRecent] = useState(false);
  const [dates, setDates] =
    useState<Readonly<{ from: LocalDate; to: LocalDate }>>();
  const canReadRuns = workspace.capabilities.includes('run:read');
  const canReadCapacity =
    canReadRuns &&
    workspace.capabilities.includes('artifact:read') &&
    isWorkspaceBrowsable(workspace);
  const capacity = useQuery({
    ...usageCapacityQueryOptions(apiClient, user.id, workspace.id),
    enabled: canReadCapacity,
  });
  const trends = useQuery({
    ...usageTrendsQueryOptions(apiClient, user.id, workspace.id, search.period),
    enabled: canReadRuns,
  });
  // Do not retain forbidden figures on permission/state loss, even if Query has a previous snapshot.
  const capacityData =
    canReadCapacity && !isReadAccessLost(capacity.error)
      ? capacity.data
      : undefined;
  const trendData =
    canReadRuns && !isReadAccessLost(trends.error) ? trends.data : undefined;
  const asOf = olderOf(capacityData?.asOf, trendData?.asOf);
  const firstDay = trendData?.days[0]?.day;
  const lastDay = trendData?.days.at(-1)?.day;
  const bounds =
    firstDay === undefined || lastDay === undefined
      ? undefined
      : { from: firstDay, to: lastDay };
  return (
    <div className="flex max-w-190 flex-col gap-6">
      <PageHeader>
        <div>
          <PageHeaderTitle>Usage</PageHeaderTitle>
          <p className="mt-3 text-meta text-subtle-foreground">
            What ran in {workspace.name} and how much room is left.
            {asOf === undefined ? null : (
              <>
                {' '}
                <span className="font-mono">
                  as of <time dateTime={asOf}>{formatShortTime(asOf)}</time>
                </span>
              </>
            )}
          </p>
        </div>
      </PageHeader>
      <div className="flex flex-col">
        {canReadCapacity ? (
          <UsageSnapshot title="Room left" query={capacity}>
            {(snapshot) => <CurrentCapacity snapshot={snapshot} />}
          </UsageSnapshot>
        ) : (
          <SettingRow layout="section" title="Room left">
            <Notice>
              {!isWorkspaceBrowsable(workspace)
                ? 'Current capacity isn’t available for a workspace being deleted.'
                : 'You need access to runs and files to see capacity.'}
            </Notice>
          </SettingRow>
        )}
        {canReadRuns ? (
          <UsageSnapshot
            title="Runs per day"
            description={`Over ${String(recent ? RECENT_USAGE_DAYS : USAGE_TREND_PERIOD_DAYS[search.period])} UTC days. Today is partial; test runs are left out.`}
            controls={
              <div className="flex flex-wrap items-center gap-2">
                <ToggleGroup
                  aria-label="Range"
                  value={
                    dates === undefined
                      ? [recent ? 'recent' : search.period]
                      : []
                  }
                  onValueChange={(values) => {
                    const choice = values[0];
                    if (choice === undefined) return;
                    setDates(undefined);
                    setRecent(choice === 'recent');
                    if (choice !== 'recent')
                      onSearchChange(parseUsageSearch({ period: choice }));
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
                      dates === undefined
                        ? 'Choose dates'
                        : `${dates.from} – ${dates.to}`
                    }
                    initial={dates ?? bounds}
                    bounds={bounds}
                    presets={[]}
                    onApply={(from, to) => {
                      if (from < bounds.from || to > bounds.to)
                        return 'Choose dates within the selected period.';
                      setDates({ from, to });
                      setRecent(false);
                      return undefined;
                    }}
                    onClear={() => {
                      setDates(undefined);
                    }}
                  />
                )}
              </div>
            }
            query={trends}
          >
            {(data) => {
              const window =
                recent || dates !== undefined
                  ? usageInWindow(data, dates)
                  : data;
              const failures = countFailureOutcomes(window.byStatus);
              return (
                <div className="flex flex-col gap-4">
                  <p className="font-mono text-meta text-muted-foreground">
                    {formatCount(window.total, 'run')} · {String(failures)}{' '}
                    failed
                  </p>
                  <DailyChart snapshot={window} appearance="failure-share" />
                  <p className="text-meta text-subtle-foreground">
                    Red shows runs that failed, timed out or ended with an
                    unknown outcome.{' '}
                    <Link
                      to="/w/$workspaceId/settings/usage/trends"
                      params={{ workspaceId: workspace.id }}
                      search={{ period: search.period }}
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
                          params={{ workspaceId: workspace.id }}
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
        ) : (
          <SettingRow layout="section" title="Runs per day">
            <Notice>You need access to runs to see how many ran.</Notice>
          </SettingRow>
        )}
        {trendData === undefined ? null : (
          <SettingRow
            layout="section"
            title="By workflow"
            description={
              recent || dates !== undefined
                ? `Rankings cover the last ${String(USAGE_TREND_PERIOD_DAYS[search.period])} days.`
                : undefined
            }
          >
            <WorkflowRankings
              items={trendData.busiest}
              metric="runs"
              workspaceId={workspace.id}
              canOpen={workspace.capabilities.includes('workflow:read')}
            />
          </SettingRow>
        )}
      </div>
    </div>
  );
}
