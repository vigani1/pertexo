import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { TodayRuns } from '../components/today-runs';
import { useHomeRefresh } from '../data/home-refresh';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  Empty,
  EmptyDescription,
  EmptyTitle,
} from '@/components/patterns/states/empty';
import { SkeletonLines } from '@/components/patterns/states/loading';
import {
  type RunStatistics,
  anyRunQueryOptions,
  runStatisticsQueryOptions,
} from '@/features/workflow-runs/workflow-runs-queries.public';
import { workflowsInfiniteQueryOptions } from '@/features/workflows/workflows-queries.public';
import type { ApiClient } from '@/lib/api/client';
import { AttentionSection } from '../components/attention-section';
import { FirstThreadSection } from '../components/first-thread-section';
import { HomeHeader, HomeHeaderActions } from '../components/home-header';
import { HomeLoom } from '../components/home-loom';
import { RecentlyChanged } from '../components/recently-changed';
import { isNewWorkspace, type FirstThreadFacts } from '../model/first-thread';
import { roleLimitSentence } from '@/features/workspaces/public';
import { shownData } from '@/lib/api/error-copy';
import { useFirstRunOffer } from '../hooks/use-first-run-offer';

/**
 * Home answers three questions at a glance: what's running (the Loom),
 * what broke (Needs attention) and what changed (Recently changed). A
 * workspace that hasn't run anything gets its first-thread checklist.
 */
export function HomePage({
  apiClient,
  user,
  workspace,
  onExampleCreated,
  onReviewExamples,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  /** Opens the first-run example in Build with its guide. */
  onExampleCreated: (workflowId: string) => void;
  /** The example can't start here as is: the workflow list explains why. */
  onReviewExamples: () => void;
}>) {
  const narrow = useMediaQuery('(max-width: 47.999rem)');
  const canReadRuns = workspace.capabilities.includes('run:read');
  const canReadWorkflows = workspace.capabilities.includes('workflow:read');
  const { refreshing, refresh } = useHomeRefresh(user.id, workspace.id, {
    runs: canReadRuns,
    workflows: canReadWorkflows,
  });
  const statistics = useQuery({
    ...runStatisticsQueryOptions(apiClient, user.id, workspace.id),
    enabled: canReadRuns,
  });
  const anyRun = useQuery({
    ...anyRunQueryOptions(apiClient, user.id, workspace.id),
    enabled: canReadRuns,
  });
  const workflows = useInfiniteQuery({
    ...workflowsInfiniteQueryOptions(apiClient, user.id, workspace.id),
    enabled: canReadWorkflows,
  });
  const facts: FirstThreadFacts = {
    ...(workflows.data === undefined
      ? {}
      : { workflows: workflows.data.pages.flatMap((page) => page.items) }),
    ...(anyRun.data === undefined ? {} : { hasRun: anyRun.data }),
  };

  const firstRun = useFirstRunOffer({
    apiClient,
    userId: user.id,
    workspace,
    workflows: facts.workflows,
    onCreated: onExampleCreated,
    onNeedsReview: onReviewExamples,
  });

  const headerActions = (
    <HomeHeaderActions
      workspace={workspace}
      refreshing={refreshing}
      onRefresh={refresh}
    />
  );

  if (!canReadRuns && !canReadWorkflows)
    return (
      <div className="flex flex-col gap-10">
        <HomeHeader
          name={user.displayName}
          statistics={undefined}
          actions={headerActions}
        />
        <Empty>
          <EmptyTitle>Nothing to show for your role</EmptyTitle>
          <EmptyDescription>
            {roleLimitSentence(
              workspace.role,
              'workflow:read',
              `see workflows or runs in ${workspace.name}`,
            )}
          </EmptyDescription>
        </Empty>
      </div>
    );

  const shownStatistics = shownData(statistics);
  const newWorkspace = isNewWorkspace(facts);
  const showActivity = !newWorkspace && canReadRuns;

  const settled =
    (!canReadRuns || readSettled(anyRun)) &&
    (!canReadWorkflows || readSettled(workflows));
  return (
    <div className="flex flex-col gap-10">
      <HomeHeader
        name={user.displayName}
        statistics={shownStatistics}
        actions={narrow ? null : headerActions}
      />
      {/* One block holds the place until Home knows which layout it has. */}
      {settled ? (
        <>
          {newWorkspace ? (
            <FirstThreadSection
              apiClient={apiClient}
              userId={user.id}
              workspace={workspace}
              facts={facts}
              firstRun={firstRun}
            />
          ) : null}
          <AttentionSection
            apiClient={apiClient}
            userId={user.id}
            workspace={workspace}
          />
          {showActivity ? (
            <HomeActivity
              narrow={narrow}
              apiClient={apiClient}
              userId={user.id}
              workspace={workspace}
              statistics={shownStatistics}
            />
          ) : null}
          {newWorkspace ? null : (
            <FirstThreadSection
              apiClient={apiClient}
              userId={user.id}
              workspace={workspace}
              facts={facts}
              compact
            />
          )}
          {canReadWorkflows && (!narrow || newWorkspace) ? (
            <RecentlyChanged
              apiClient={apiClient}
              userId={user.id}
              workspaceId={workspace.id}
            />
          ) : null}
        </>
      ) : (
        <SkeletonLines label="Loading Home" lines={4} className="min-h-80" />
      )}
      {narrow && settled ? headerActions : null}
    </div>
  );
}

function readSettled(query: Readonly<{ data: unknown; isError: boolean }>) {
  return query.data !== undefined || query.isError;
}

function HomeActivity({
  narrow,
  apiClient,
  userId,
  workspace,
  statistics,
}: Readonly<{
  narrow: boolean;
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  statistics: RunStatistics | undefined;
}>) {
  if (narrow)
    return (
      <TodayRuns apiClient={apiClient} userId={userId} workspace={workspace} />
    );
  return (
    <HomeLoom
      apiClient={apiClient}
      userId={userId}
      workspaceId={workspace.id}
      current={statistics?.current}
    />
  );
}
