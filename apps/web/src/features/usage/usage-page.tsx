import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { Notice } from '@/components/ui/notice';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { ApiClient } from '@/lib/api/client';
import { CurrentCapacity } from './components/current-capacity';
import { RetainedActivity } from './components/retained-activity';
import { UsageSnapshot } from './components/usage-snapshot';
import {
  usageActivityQueryOptions,
  usageCapacityQueryOptions,
} from './usage.queries';
import { accessLost } from './usage-access';
import { parseUsageSearch, type UsageSearch } from './usage-search.public';

const windows = {
  '1h': '1 hour',
  '6h': '6 hours',
  '24h': '24 hours',
  '7d': '7 days',
} as const;

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
  const canReadRuns = workspace.capabilities.includes('run:read');
  const canReadCapacity =
    canReadRuns &&
    workspace.capabilities.includes('artifact:read') &&
    workspace.status === 'active';
  const capacity = useQuery({
    ...usageCapacityQueryOptions(apiClient, user.id, workspace.id),
    enabled: canReadCapacity,
  });
  const activity = useQuery({
    ...usageActivityQueryOptions(
      apiClient,
      user.id,
      workspace.id,
      search.window,
    ),
    enabled: canReadRuns,
  });
  // Do not retain forbidden figures on permission/state loss, even if Query has a previous snapshot.
  const capacityData =
    canReadCapacity && !accessLost(capacity.error) ? capacity.data : undefined;
  const activityData =
    canReadRuns && !accessLost(activity.error) ? activity.data : undefined;
  return (
    <div className="flex flex-col gap-10">
      <PageHeader>
        <div>
          <PageHeaderTitle>Usage</PageHeaderTitle>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
            Current operational capacity and retained run activity. These are
            separate snapshots, not billing or consumed-operation meters.
          </p>
        </div>
      </PageHeader>
      {canReadCapacity ? (
        <UsageSnapshot
          title="Current capacity"
          asOf={capacityData?.asOf}
          error={capacity.error}
          pending={capacity.isPending}
          retrying={capacity.isFetching}
          onRetry={() => {
            void capacity.refetch();
          }}
        >
          {capacityData === undefined ? null : (
            <CurrentCapacity snapshot={capacityData} />
          )}
        </UsageSnapshot>
      ) : (
        <section aria-label="Current capacity">
          <h2 className="mb-4 font-heading text-lg font-semibold">
            Current capacity
          </h2>
          <Notice>
            {workspace.status !== 'active'
              ? 'Current capacity is available only for an active workspace.'
              : 'Current capacity requires both run and artifact read access.'}
          </Notice>
        </section>
      )}
      {canReadRuns ? (
        <div className="space-y-4">
          <ToggleGroup
            aria-label="Activity window"
            value={[search.window]}
            onValueChange={(values) => {
              if (values[0] !== undefined)
                onSearchChange(parseUsageSearch({ window: values[0] }));
            }}
          >
            {Object.entries(windows).map(([value, label]) => (
              <ToggleGroupItem key={value} value={value}>
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <UsageSnapshot
            title="Retained run activity"
            asOf={activityData?.asOf}
            error={activity.error}
            pending={activity.isPending}
            retrying={activity.isFetching}
            onRetry={() => {
              void activity.refetch();
            }}
          >
            {activityData === undefined ? null : (
              <RetainedActivity
                snapshot={activityData}
                workspaceId={workspace.id}
                canReadWorkflowNames={workspace.capabilities.includes(
                  'workflow:read',
                )}
              />
            )}
          </UsageSnapshot>
          <p className="text-xs text-subtle-foreground">
            Fixed durations do not use calendar resets or timezone settings.
            Activity and current capacity refresh independently every 30 seconds
            while this page is visible.
          </p>
        </div>
      ) : (
        <Notice>Retained run activity requires run read access.</Notice>
      )}
    </div>
  );
}
