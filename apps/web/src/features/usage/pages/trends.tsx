import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
  UsageTrendPeriod,
} from '@pertexo/contracts';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { SettingsSection } from '@/components/patterns/settings/section';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Notice } from '@/components/ui/notice';
import { formatDurationMs, formatDateTime } from '@/lib/format/time';
import type { ApiClient } from '@/lib/api/client';
import { usageTrendsQueryOptions } from '../data/usage.queries';
import { accessLost } from '../model/usage-access';
import { UsageSnapshot } from '../components/usage-snapshot';
import { DailyChart } from '../components/trends/daily-chart';
import { WorkflowRankings } from '../components/trends/rankings';
import { FORMAT_LOCALE } from '@/lib/format/locale';
export function UsageTrendsPage({
  apiClient,
  user,
  workspace,
  period,
  onPeriodChange,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  period: UsageTrendPeriod;
  onPeriodChange: (period: UsageTrendPeriod) => void;
}>) {
  const allowed = workspace.capabilities.includes('run:read');
  const query = useQuery({
    ...usageTrendsQueryOptions(apiClient, user.id, workspace.id, period),
    enabled: allowed,
  });
  const data = allowed && !accessLost(query.error) ? query.data : undefined;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader>
        <div>
          <PageHeaderTitle>Trends</PageHeaderTitle>
          <p className="mt-3 text-sm text-muted-foreground">
            Runs over {period === '30d' ? '30' : '90'} UTC days, including
            today. Today is partial; test runs are excluded.
          </p>
          <Link
            className="mt-2 inline-block text-sm underline underline-offset-4"
            to="/w/$workspaceId/settings/usage"
            params={{ workspaceId: workspace.id }}
            search={{ window: '24h' }}
          >
            Current usage
          </Link>
        </div>
      </PageHeader>
      {!allowed ? (
        <Notice>You need access to runs to see trends.</Notice>
      ) : (
        <>
          <UsageSnapshot
            title="Daily outcomes"
            description="What each day's runs look like now."
            controls={
              <ToggleGroup
                aria-label="Trends period"
                value={[period]}
                onValueChange={(values) => {
                  if (values[0] === '30d' || values[0] === '90d')
                    onPeriodChange(values[0]);
                }}
              >
                <ToggleGroupItem value="30d">30 days</ToggleGroupItem>
                <ToggleGroupItem value="90d">90 days</ToggleGroupItem>
              </ToggleGroup>
            }
            query={query}
          >
            {(data) => (
              <div className="space-y-6">
                <p className="text-lg tabular-nums">
                  {data.total.toLocaleString(FORMAT_LOCALE)} runs
                </p>
                <DailyChart snapshot={data} />
                <p className="text-xs text-muted-foreground">
                  Retained summaries from {formatDateTime(data.coverageFrom)}.
                  Snapshot {formatDateTime(data.asOf)}.
                </p>
              </div>
            )}
          </UsageSnapshot>
          {data === undefined ? null : (
            <>
              <SettingsSection
                title="Elapsed duration"
                description="Completed runs with a start time. Includes waits; excludes the queue before starting."
              >
                <dl className="flex flex-wrap gap-x-12 gap-y-4">
                  <div>
                    <dt className="text-sm text-muted-foreground">Average</dt>
                    <dd className="mt-1 text-lg tabular-nums">
                      {formatDurationMs(data.elapsed.averageMs)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">Slowest</dt>
                    <dd className="mt-1 text-lg tabular-nums">
                      {formatDurationMs(data.elapsed.slowestMs)}
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs text-muted-foreground">
                  Measured across{' '}
                  {data.elapsed.measuredRuns.toLocaleString(FORMAT_LOCALE)}{' '}
                  completed runs.
                </p>
              </SettingsSection>
              <SettingsSection
                title="Most runs"
                description="The ten busiest workflows in this period."
              >
                <WorkflowRankings
                  items={data.busiest}
                  metric="runs"
                  workspaceId={workspace.id}
                  canOpen={workspace.capabilities.includes('workflow:read')}
                />
              </SettingsSection>
              <SettingsSection
                title="Most failures"
                description="Failed, timed-out and unknown-outcome runs."
              >
                <WorkflowRankings
                  items={data.mostFailures}
                  metric="failures"
                  workspaceId={workspace.id}
                  canOpen={workspace.capabilities.includes('workflow:read')}
                />
              </SettingsSection>
            </>
          )}
        </>
      )}
    </div>
  );
}
