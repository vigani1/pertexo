import { UsageRuns, type UsageDates } from '../components/usage-runs';
import { isWorkspaceBrowsable } from '@/features/workspaces/public';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { USAGE_TREND_PERIOD_DAYS } from '@pertexo/workflow-model';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { SettingRow } from '@/components/patterns/settings/row';
import { Notice } from '@/components/patterns/notices/inline-notice';
import type { ApiClient } from '@/lib/api/client';
import { formatShortTime } from '@/lib/format/time';
import { CurrentCapacity } from '../components/current-capacity';
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
  const [dates, setDates] = useState<UsageDates>();
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
                  as of{' '}
                  <time dateTime={asOf}>{formatShortTime(asOf, 'h23')}</time>
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
          <UsageRuns
            workspaceId={workspace.id}
            period={search.period}
            recent={recent}
            dates={dates}
            trends={trends}
            trendData={trendData}
            onPeriod={(choice) => {
              setDates(undefined);
              setRecent(choice === 'recent');
              if (choice !== 'recent')
                onSearchChange(parseUsageSearch({ period: choice }));
            }}
            onDates={(next) => {
              setDates(next);
              setRecent(false);
            }}
          />
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
