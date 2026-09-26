import type { RefObject } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type {
  WorkflowListResponse,
  WorkflowSummary,
} from '@pertexo/contracts/schemas/workflow-authoring';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { StaleLine } from '@/components/patterns/stale-line';
import type { ApiClient } from '@/lib/api/client';
import {
  countWorkflowViews,
  filterWorkflows,
  updateWorkflowListSearch,
  type WorkflowListSearch,
} from '../model/workflow-list-view';
import type { RecentRunTicks } from '../use-recent-run-ticks';
import { WorkflowListNoMatches } from './workflow-list-states';
import { WorkflowListToolbar } from './workflow-list-toolbar';
import type { WorkflowRowActions } from './workflow-row-actions';
import { WorkflowListFooter, WorkflowRows } from './workflow-rows';

/**
 * The loaded workflows with their toolbar: the view and sort in the URL, the
 * filter over what's loaded, one stale line after a failed refresh, and the
 * next page.
 */
export function WorkflowListResults({
  apiClient,
  userId,
  workspace,
  workflows,
  items,
  search,
  query,
  filterRef,
  runs,
  onQueryChange,
  onSearchChange,
  actions,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflows: UseInfiniteQueryResult<InfiniteData<WorkflowListResponse>>;
  items: readonly WorkflowSummary[];
  search: WorkflowListSearch;
  query: string;
  filterRef: RefObject<HTMLInputElement | null>;
  runs: RecentRunTicks;
  onQueryChange: (query: string) => void;
  onSearchChange: (search: WorkflowListSearch) => void;
  actions: WorkflowRowActions;
}>) {
  const view = search.view ?? 'active';
  const sort = search.sort ?? 'updated';
  const visible = filterWorkflows(items, { view, query });
  return (
    <section aria-label="Workspace workflows" className="flex flex-col gap-4">
      <WorkflowListToolbar
        filterRef={filterRef}
        query={query}
        view={view}
        sort={sort}
        counts={countWorkflowViews(items)}
        hasMore={workflows.hasNextPage}
        onQueryChange={onQueryChange}
        onViewChange={(next) => {
          onSearchChange(updateWorkflowListSearch(search, { view: next }));
        }}
        onSortChange={(next) => {
          onSearchChange(updateWorkflowListSearch(search, { sort: next }));
        }}
      />
      {workflows.isRefetchError ? (
        <StaleLine
          updatedAt={workflows.dataUpdatedAt}
          retrying={workflows.isFetching}
          onRetry={() => void workflows.refetch()}
        />
      ) : null}
      {visible.length === 0 ? (
        <WorkflowListNoMatches
          view={view}
          query={query}
          onClear={() => {
            onQueryChange('');
            if (query.trim() === '')
              onSearchChange(updateWorkflowListSearch(search, { view: 'all' }));
          }}
        />
      ) : (
        <WorkflowRows
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          workflows={visible}
          runs={runs}
          actions={actions}
        />
      )}
      <WorkflowListFooter
        hasNextPage={workflows.hasNextPage}
        loadingNextPage={workflows.isFetchingNextPage}
        nextPageError={workflows.isFetchNextPageError}
        filtering={query.trim() !== '' || view !== 'all'}
        loadedCount={items.length}
        // The note explains the Recent runs column, so only with rows.
        runCount={
          visible.length > 0 && runs.enabled && !runs.pending && !runs.failed
            ? runs.runCount
            : undefined
        }
        onLoadMore={() => void workflows.fetchNextPage()}
      />
    </section>
  );
}
