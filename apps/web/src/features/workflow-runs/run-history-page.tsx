import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import {
  workflowsInfiniteQueryOptions,
  workflowSummaryQueryOptions,
} from '@/features/workflows/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { LiveRunCounts } from './components/run-count';
import { RunFilters } from './components/run-filters/run-filters';
import { WorkflowPicker } from './components/run-filters/workflow-picker';
import { RunsForbidden } from './components/run-list/run-list-states';
import { RunResults } from './components/run-list/run-results';
import { RunsToolbar } from './components/run-list/runs-toolbar';
import {
  filtersFromSearch,
  withoutRunFilter,
  withRunView,
  type RunSearch,
} from './model/run-search';
import { useRunHistory } from './use-run-history';
import { runStatusCountsQueryOptions } from './workflow-runs.queries';

/** The workspace's run log: live counts, URL filters, List or Loom. */
export function RunHistoryPage({
  apiClient,
  user,
  workspace,
  search,
  onSearchChange,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  search: RunSearch;
  onSearchChange: (search: RunSearch) => void;
}>) {
  const [live, setLive] = useState(false);
  const { query, runs, canRead } = useRunHistory({
    apiClient,
    userId: user.id,
    workspace,
    filters: filtersFromSearch(search),
    live,
  });
  const counts = useQuery({
    ...runStatusCountsQueryOptions(apiClient, user.id, workspace.id),
    enabled: canRead,
  });
  const canReadWorkflows = workspace.capabilities.includes('workflow:read');
  const workflows = useInfiniteQuery({
    ...workflowsInfiniteQueryOptions(apiClient, user.id, workspace.id),
    enabled: canRead && canReadWorkflows,
  });
  const selected = useQuery({
    ...workflowSummaryQueryOptions(
      apiClient,
      user.id,
      workspace.id,
      search.workflowId ?? '',
    ),
    enabled: canReadWorkflows && search.workflowId !== undefined,
  });
  const workflowName =
    search.workflowId === undefined ? undefined : selected.data?.name;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader>
        <div className="min-w-0">
          <PageHeaderTitle>Runs</PageHeaderTitle>
          <PageHeaderMeta>
            {counts.data === undefined ? (
              <span>Every run in {workspace.name}</span>
            ) : (
              <LiveRunCounts counts={counts.data} />
            )}
          </PageHeaderMeta>
        </div>
        {canRead ? (
          <PageHeaderActions>
            <RunsToolbar
              live={live}
              onLiveChange={setLive}
              view={search.view ?? 'list'}
              onViewChange={(view) => {
                onSearchChange(withRunView(search, view));
              }}
            />
          </PageHeaderActions>
        ) : null}
      </PageHeader>
      {canRead ? (
        <>
          <RunFilters
            search={search}
            onSearchChange={onSearchChange}
            {...(workflowName === undefined ? {} : { workflowName })}
            workflowFilter={
              canReadWorkflows ? (
                <WorkflowPicker
                  key={`${search.workflowId ?? ''}:${search.workflowNamePrefix ?? ''}:${workflowName ?? ''}`}
                  workflows={
                    workflows.data?.pages.flatMap((page) => page.items) ?? []
                  }
                  initialText={workflowName ?? search.workflowNamePrefix ?? ''}
                  onPickWorkflow={(workflow) => {
                    onSearchChange({
                      ...withoutRunFilter(search, 'workflowNamePrefix'),
                      workflowId: workflow.id,
                    });
                  }}
                  onNamePrefix={(prefix) => {
                    const rest = withoutRunFilter(
                      withoutRunFilter(search, 'workflowId'),
                      'workflowNamePrefix',
                    );
                    onSearchChange(
                      prefix === undefined
                        ? rest
                        : { ...rest, workflowNamePrefix: prefix },
                    );
                  }}
                />
              ) : undefined
            }
          />
          <RunResults
            apiClient={apiClient}
            userId={user.id}
            workspace={workspace}
            search={search}
            onSearchChange={onSearchChange}
            query={query}
            runs={runs}
            variant="workspace"
          />
        </>
      ) : (
        <RunsForbidden />
      )}
    </div>
  );
}
