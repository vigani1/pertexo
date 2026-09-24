import { useRef, useState } from 'react';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from '@tanstack/react-query';
import { StaleLine } from '@/components/patterns/stale-line';
import { SkeletonThread } from '@/components/ui/skeleton';
import { authoringCatalogQueryOptions } from '@/features/catalog/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { NewWorkflowSheet } from './components/new-workflow-sheet';
import type { StartChoice } from './components/starter-choice';
import { WorkflowLifecycleDialog } from './components/workflow-lifecycle-dialog';
import { WorkflowListEmpty } from './components/workflow-list-empty';
import { WorkflowListHeader } from './components/workflow-list-header';
import {
  WorkflowListError,
  WorkflowListNoMatches,
} from './components/workflow-list-states';
import { WorkflowListToolbar } from './components/workflow-list-toolbar';
import {
  WorkflowListFooter,
  WorkflowRows,
  WorkflowRowsSkeleton,
} from './components/workflow-rows';
import {
  lifecycleIntentFor,
  type LifecycleIntent,
} from './model/workflow-lifecycle';
import {
  WORKFLOW_ORDER_BY_SORT,
  countWorkflowViews,
  filterWorkflows,
  updateWorkflowListSearch,
  type WorkflowListSearch,
} from './model/workflow-list-view';
import { availableStarters } from './model/workflow-starters';
import { useListShortcuts } from './use-list-shortcuts';
import { useRecentRunTicks } from './use-recent-run-ticks';
import type { StarterDraftWriter } from './workflows.mutations';
import { workflowsInfiniteQueryOptions } from './workflows.queries';

type LifecycleTarget = Readonly<{
  workflow: WorkflowSummary;
  intent: LifecycleIntent;
}>;

export function WorkflowListPage({
  apiClient,
  user,
  workspace,
  search,
  starterDraftWriter,
  onSearchChange,
  onCreated,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  search: WorkflowListSearch;
  /** Saves starter steps; without it the lens offers Blank only. */
  starterDraftWriter?: StarterDraftWriter | undefined;
  onSearchChange: (search: WorkflowListSearch) => void;
  onCreated: (workflowId: string) => void;
}>) {
  const view = search.view ?? 'active';
  const sort = search.sort ?? 'updated';
  const canCreate = workspace.capabilities.includes('workflow:create');
  // Changing the sort keeps the current rows until the re-sorted pages land.
  const workflows = useInfiniteQuery({
    ...workflowsInfiniteQueryOptions(
      apiClient,
      user.id,
      workspace.id,
      WORKFLOW_ORDER_BY_SORT[sort],
    ),
    placeholderData: keepPreviousData,
  });
  const catalog = useQuery({
    ...authoringCatalogQueryOptions(apiClient, user.id),
    enabled: canCreate && starterDraftWriter !== undefined,
  });
  const runs = useRecentRunTicks(
    apiClient,
    user.id,
    workspace.id,
    workspace.capabilities.includes('run:read'),
  );
  const filterRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [startChoice, setStartChoice] = useState<StartChoice>('blank');
  const [lifecycle, setLifecycle] = useState<LifecycleTarget>();

  const items = workflows.data?.pages.flatMap((page) => page.items) ?? [];
  const visible = filterWorkflows(items, { view, query });
  const starters =
    catalog.data === undefined || starterDraftWriter === undefined
      ? []
      : availableStarters(catalog.data.definitions);
  const empty = workflows.data !== undefined && items.length === 0;

  function openCreate(choice: StartChoice) {
    setStartChoice(choice);
    onSearchChange(updateWorkflowListSearch(search, { create: true }));
  }

  useListShortcuts({
    onFocusFilter: () => {
      filterRef.current?.focus();
    },
    onCreate: canCreate
      ? () => {
          openCreate('blank');
        }
      : undefined,
  });

  return (
    <div className="flex flex-col gap-6">
      <WorkflowListHeader
        workflows={items}
        loading={workflows.isPending}
        hasMore={workflows.hasNextPage}
        showCreate={canCreate && !empty}
        onCreate={() => {
          openCreate('blank');
        }}
      />
      {workflows.isFetching &&
      !workflows.isPending &&
      !workflows.isFetchingNextPage ? (
        <SkeletonThread
          role="status"
          aria-label="Refreshing workflows"
          className="-mt-3 w-full"
        />
      ) : null}
      {workflows.isPending ? (
        <WorkflowRowsSkeleton />
      ) : workflows.data === undefined ? (
        <WorkflowListError
          error={workflows.error}
          retrying={workflows.isFetching}
          onRetry={() => void workflows.refetch()}
        />
      ) : empty ? (
        <WorkflowListEmpty
          canCreate={canCreate}
          starters={starters}
          onStart={openCreate}
        />
      ) : (
        <section
          aria-label="Workspace workflows"
          className="flex flex-col gap-4"
        >
          <WorkflowListToolbar
            filterRef={filterRef}
            query={query}
            view={view}
            sort={sort}
            counts={countWorkflowViews(items)}
            hasMore={workflows.hasNextPage}
            onQueryChange={setQuery}
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
                setQuery('');
                if (query.trim() === '')
                  onSearchChange(
                    updateWorkflowListSearch(search, { view: 'all' }),
                  );
              }}
            />
          ) : (
            <WorkflowRows
              apiClient={apiClient}
              userId={user.id}
              workspace={workspace}
              workflows={visible}
              runs={runs}
              onLifecycle={(workflow) => {
                setLifecycle({
                  workflow,
                  intent: lifecycleIntentFor(workflow),
                });
              }}
            />
          )}
          <WorkflowListFooter
            hasNextPage={workflows.hasNextPage}
            loadingNextPage={workflows.isFetchingNextPage}
            nextPageError={workflows.isFetchNextPageError}
            filtering={query.trim() !== '' || view !== 'all'}
            loadedCount={items.length}
            runCount={
              runs.enabled && !runs.pending && !runs.failed
                ? runs.runCount
                : undefined
            }
            onLoadMore={() => void workflows.fetchNextPage()}
          />
        </section>
      )}
      {canCreate ? (
        <NewWorkflowSheet
          apiClient={apiClient}
          userId={user.id}
          workspaceId={workspace.id}
          open={search.create === true}
          starters={starters}
          choice={startChoice}
          writer={starterDraftWriter}
          onChoiceChange={setStartChoice}
          onOpenChange={(open) => {
            onSearchChange(updateWorkflowListSearch(search, { create: open }));
          }}
          onCreated={onCreated}
        />
      ) : null}
      {lifecycle === undefined ? null : (
        <WorkflowLifecycleDialog
          key={lifecycle.workflow.id}
          apiClient={apiClient}
          userId={user.id}
          workspaceId={workspace.id}
          workflowId={lifecycle.workflow.id}
          workflowName={lifecycle.workflow.name}
          intent={lifecycle.intent}
          onClose={() => {
            setLifecycle(undefined);
          }}
        />
      )}
    </div>
  );
}
