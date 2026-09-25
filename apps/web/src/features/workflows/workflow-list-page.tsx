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
import { SkeletonThread } from '@/components/ui/skeleton';
import { authoringCatalogQueryOptions } from '@/features/catalog/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { NewWorkflowSheet } from './components/new-workflow-sheet';
import type { StartChoice } from './components/starter-choice';
import { WorkflowLifecycleDialog } from './components/workflow-lifecycle-dialog';
import { WorkflowListEmpty } from './components/workflow-list-empty';
import {
  NewWorkflowButton,
  WorkflowListHeader,
} from './components/workflow-list-header';
import { WorkflowListResults } from './components/workflow-list-results';
import { WorkflowListError } from './components/workflow-list-states';
import { WorkflowRenameDialog } from './components/workflow-rename-dialog';
import { WorkflowRowsSkeleton } from './components/workflow-rows';
import {
  lifecycleIntentFor,
  type LifecycleIntent,
} from './model/workflow-lifecycle';
import {
  WORKFLOW_ORDER_BY_SORT,
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

/** A refetch of pages already on screen, not the first load or a next page. */
function refreshingInBackground(
  query: Readonly<{
    isFetching: boolean;
    isPending: boolean;
    isFetchingNextPage: boolean;
  }>,
): boolean {
  return query.isFetching && !query.isPending && !query.isFetchingNextPage;
}

/** Which of the list's four states is on screen. */
function listState(
  pending: boolean,
  loaded: boolean,
  empty: boolean,
): 'loading' | 'failed' | 'empty' | 'results' {
  if (pending) return 'loading';
  if (!loaded) return 'failed';
  return empty ? 'empty' : 'results';
}

function startersFrom(
  catalog:
    | Readonly<{ definitions: Parameters<typeof availableStarters>[0] }>
    | undefined,
) {
  return catalog === undefined ? [] : availableStarters(catalog.definitions);
}

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
  const [renaming, setRenaming] = useState<WorkflowSummary>();

  const items = workflows.data?.pages.flatMap((page) => page.items) ?? [];
  const starters =
    starterDraftWriter === undefined ? [] : startersFrom(catalog.data);
  const empty = workflows.data !== undefined && items.length === 0;
  const shown = listState(
    workflows.isPending,
    workflows.data !== undefined,
    empty,
  );

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
        actions={
          canCreate && !empty ? (
            <NewWorkflowButton
              onClick={() => {
                openCreate('blank');
              }}
            />
          ) : undefined
        }
      />
      {refreshingInBackground(workflows) ? (
        <SkeletonThread
          role="status"
          aria-label="Refreshing workflows"
          className="-mt-3 w-full"
        />
      ) : null}
      {shown === 'loading' ? <WorkflowRowsSkeleton /> : null}
      {shown === 'failed' ? (
        <WorkflowListError
          error={workflows.error}
          retrying={workflows.isFetching}
          onRetry={() => void workflows.refetch()}
        />
      ) : null}
      {shown === 'empty' ? (
        <WorkflowListEmpty
          canCreate={canCreate}
          starters={starters}
          onStart={openCreate}
        />
      ) : null}
      {shown === 'results' ? (
        <WorkflowListResults
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          workflows={workflows}
          items={items}
          search={search}
          query={query}
          filterRef={filterRef}
          runs={runs}
          onQueryChange={setQuery}
          onSearchChange={onSearchChange}
          onRename={setRenaming}
          onLifecycle={(workflow) => {
            setLifecycle({ workflow, intent: lifecycleIntentFor(workflow) });
          }}
        />
      ) : null}
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
      {renaming === undefined ? null : (
        <WorkflowRenameDialog
          key={renaming.id}
          apiClient={apiClient}
          userId={user.id}
          workspaceId={workspace.id}
          workflow={renaming}
          onClose={() => {
            setRenaming(undefined);
          }}
        />
      )}
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
