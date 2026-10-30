import { isWorkspaceBrowsable } from '@/features/workspaces/availability.public';
import { Link } from '@tanstack/react-router';
import { ChartLineIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button-variants';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { SettingsSection } from '@/components/patterns/settings/section';
import { Notice } from '@/components/ui/notice';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { ApiClient } from '@/lib/api/client';
import { formatShortTime } from '@/lib/format/time';
import { CurrentCapacity } from '../components/current-capacity';
import { RetainedActivity } from '../components/retained-activity';
import { UsageSnapshot } from '../components/usage-snapshot';
import {
  usageActivityQueryOptions,
  usageCapacityQueryOptions,
} from '../data/usage.queries';
import { accessLost } from '../model/usage-access';
import { parseUsageSearch, type UsageSearch } from '../search.public';

const windows = {
  '1h': '1 hour',
  '6h': '6 hours',
  '24h': '24 hours',
  '7d': '7 days',
} as const;

const windowPhrases: Readonly<Record<keyof typeof windows, string>> = {
  '1h': 'in the last hour',
  '6h': 'in the last 6 hours',
  '24h': 'in the last 24 hours',
  '7d': 'in the last 7 days',
};

/** The older of two snapshot times: the page is only as fresh as that. */
function olderOf(...times: readonly (string | undefined)[]) {
  return times
    .filter((time) => time !== undefined)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}

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
    isWorkspaceBrowsable(workspace);
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
  const asOf = olderOf(capacityData?.asOf, activityData?.asOf);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader>
        <div>
          <PageHeaderTitle>Usage</PageHeaderTitle>
          {asOf === undefined ? null : (
            <PageHeaderMeta>
              <span>
                as of <time dateTime={asOf}>{formatShortTime(asOf)}</time>
              </span>
            </PageHeaderMeta>
          )}
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
            What this workspace is using right now, and how many runs started
            recently.
          </p>
        </div>
        {canReadRuns ? (
          <PageHeaderActions>
            <Link
              className={buttonVariants({ variant: 'outline' })}
              to="/w/$workspaceId/settings/usage/trends"
              params={{ workspaceId: workspace.id }}
              search={{ period: '30d' }}
            >
              <ChartLineIcon aria-hidden="true" data-icon="inline-start" />
              View trends
            </Link>
          </PageHeaderActions>
        ) : null}
      </PageHeader>
      <div className="flex flex-col">
        {canReadCapacity ? (
          <UsageSnapshot
            title="Current capacity"
            description="What’s running, waiting to start and stored right now."
            query={capacity}
          >
            {(snapshot) => <CurrentCapacity snapshot={snapshot} />}
          </UsageSnapshot>
        ) : (
          <SettingsSection title="Current capacity">
            <Notice>
              {!isWorkspaceBrowsable(workspace)
                ? 'Current capacity isn’t available for a workspace being deleted.'
                : 'You need access to runs and files to see capacity.'}
            </Notice>
          </SettingsSection>
        )}
        {canReadRuns ? (
          <UsageSnapshot
            title="Recent runs"
            description="Runs that started in the chosen window, by where they stand now."
            controls={
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
            }
            query={activity}
          >
            {(snapshot) => (
              <RetainedActivity
                snapshot={snapshot}
                windowPhrase={windowPhrases[search.window]}
                workspaceId={workspace.id}
                canReadWorkflowNames={workspace.capabilities.includes(
                  'workflow:read',
                )}
              />
            )}
          </UsageSnapshot>
        ) : (
          <SettingsSection title="Recent runs">
            <Notice>You need access to runs to see recent runs.</Notice>
          </SettingsSection>
        )}
      </div>
    </div>
  );
}
