import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import {
  anyRunQueryOptions,
  attentionRunsQueryOptions,
  runStatusCountsQueryOptions,
  workflowRunKeys,
} from '@/features/workflow-runs/queries.public';
import {
  workflowKeys,
  workflowsInfiniteQueryOptions,
} from '@/features/workflows/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { AttentionSection } from './components/attention-section';
import { FirstThreadSection } from './components/first-thread-section';
import { HomeHeader } from './components/home-header';
import { HomeLoom } from './components/home-loom';
import { RecentlyChanged } from './components/recently-changed';
import { isNewWorkspace, type FirstThreadFacts } from './model/first-thread';

/**
 * Home answers three questions at a glance: what's running (the Loom),
 * what broke (Needs attention) and what changed (Recently changed). A
 * workspace that hasn't run anything gets its first-thread checklist.
 */
export function HomePage({
  apiClient,
  user,
  workspace,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
}>) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const canReadRuns = workspace.capabilities.includes('run:read');
  const canReadWorkflows = workspace.capabilities.includes('workflow:read');
  const counts = useQuery({
    ...runStatusCountsQueryOptions(apiClient, user.id, workspace.id),
    enabled: canReadRuns,
  });
  const attention = useQuery({
    ...attentionRunsQueryOptions(apiClient, user.id, workspace.id),
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

  function refresh() {
    setRefreshing(true);
    const scopes = [
      ...(canReadRuns ? [workflowRunKeys.scope(user.id, workspace.id)] : []),
      ...(canReadWorkflows ? [workflowKeys.scope(user.id, workspace.id)] : []),
    ];
    void Promise.allSettled(
      scopes.map((queryKey) =>
        queryClient.refetchQueries({ queryKey, type: 'active' }),
      ),
    ).finally(() => {
      setRefreshing(false);
    });
  }

  if (!canReadRuns && !canReadWorkflows)
    return (
      <div className="flex flex-col gap-10">
        <HomeHeader
          workspace={workspace}
          counts={undefined}
          attention={undefined}
          countsUpdatedAt={0}
          refreshing={false}
          onRefresh={refresh}
        />
        <Empty>
          <EmptyTitle>Nothing to show for your role</EmptyTitle>
          <EmptyDescription>
            Your role in {workspace.name} can’t see workflows or runs. Ask an
            admin or owner if you need them.
          </EmptyDescription>
        </Empty>
      </div>
    );

  return (
    <div className="flex flex-col gap-10">
      <HomeHeader
        workspace={workspace}
        counts={counts.data}
        attention={attention.data}
        countsUpdatedAt={counts.dataUpdatedAt}
        refreshing={refreshing}
        onRefresh={refresh}
      />
      {isNewWorkspace(facts) ? (
        <FirstThreadSection
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          facts={facts}
        />
      ) : canReadRuns ? (
        <HomeLoom
          apiClient={apiClient}
          userId={user.id}
          workspaceId={workspace.id}
          counts={counts.data}
        />
      ) : null}
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <AttentionSection
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
        />
        {canReadWorkflows ? (
          <RecentlyChanged
            apiClient={apiClient}
            userId={user.id}
            workspaceId={workspace.id}
          />
        ) : null}
      </div>
    </div>
  );
}
