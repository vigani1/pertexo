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
import { useRunWorkflow } from './use-run-workflow';
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

type ListScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
}>;

/**
 * The list's pages in the chosen order, the starters the catalog can build,
 * and which of the list's states is on screen. Changing the sort keeps the
 * current rows until the re-sorted pages land.
 */
function useWorkflowList(
  { apiClient, userId, workspace }: ListScope,
  sort: keyof typeof WORKFLOW_ORDER_BY_SORT,
  starterDraftWriter: StarterDraftWriter | undefined,
) {
  const canCreate = workspace.capabilities.includes('workflow:create');
  const workflows = useInfiniteQuery({
    ...workflowsInfiniteQueryOptions(
      apiClient,
      userId,
      workspace.id,
      WORKFLOW_ORDER_BY_SORT[sort],
    ),
    placeholderData: keepPreviousData,
  });
  const catalog = useQuery({
    ...authoringCatalogQueryOptions(apiClient, userId),
    enabled: canCreate && starterDraftWriter !== undefined,
  });
  const items = workflows.data?.pages.flatMap((page) => page.items) ?? [];
  const empty = workflows.data !== undefined && items.length === 0;
  return {
    workflows,
    items,
    empty,
    starters:
      starterDraftWriter === undefined ? [] : startersFrom(catalog.data),
    shown: listState(workflows.isPending, workflows.data !== undefined, empty),
  } as const;
}

/** Renaming or archiving/restoring one workflow, over the list. */
function WorkflowDialogs({
  apiClient,
  userId,
  workspaceId,
  renaming,
  lifecycle,
  onRenameClose,
  onLifecycleClose,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  renaming: WorkflowSummary | undefined;
  lifecycle: LifecycleTarget | undefined;
  onRenameClose: () => void;
  onLifecycleClose: () => void;
}>) {
  return (
    <>
      {renaming === undefined ? null : (
        <WorkflowRenameDialog
          key={renaming.id}
          apiClient={apiClient}
          userId={userId}
          workspaceId={workspaceId}
          workflow={renaming}
          onClose={onRenameClose}
        />
      )}
      {lifecycle === undefined ? null : (
        <WorkflowLifecycleDialog
          key={lifecycle.workflow.id}
          apiClient={apiClient}
          userId={userId}
          workspaceId={workspaceId}
          workflowId={lifecycle.workflow.id}
          workflowName={lifecycle.workflow.name}
          intent={lifecycle.intent}
          onClose={onLifecycleClose}
        />
      )}
    </>
  );
}

export function WorkflowListPage({
  apiClient,
  user,
  workspace,
  search,
  starterDraftWriter,
  onSearchChange,
  onCreated,
  onRunStarted,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  search: WorkflowListSearch;
  /** Saves starter steps; without it the lens offers Blank only. */
  starterDraftWriter?: StarterDraftWriter | undefined;
  onSearchChange: (search: WorkflowListSearch) => void;
  onCreated: (workflowId: string) => void;
  /** Opens a run started from a row. */
  onRunStarted: (runId: string) => void;
}>) {
  const canCreate = workspace.capabilities.includes('workflow:create');
  const scope = { apiClient, userId: user.id, workspace };
  const list = useWorkflowList(
    scope,
    search.sort ?? 'updated',
    starterDraftWriter,
  );
  const { workflows } = list;
  const filterRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [startChoice, setStartChoice] = useState<StartChoice>('blank');
  const [lifecycle, setLifecycle] = useState<LifecycleTarget>();
  const [renaming, setRenaming] = useState<WorkflowSummary>();
  const runner = useRunWorkflow({
    apiClient,
    userId: user.id,
    workspaceId: workspace.id,
    onRunStarted,
  });

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
        workflows={list.items}
        loading={workflows.isPending}
        hasMore={workflows.hasNextPage}
        actions={
          canCreate && !list.empty ? (
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
      {list.shown === 'loading' ? <WorkflowRowsSkeleton /> : null}
      {list.shown === 'failed' ? (
        <WorkflowListError
          error={workflows.error}
          retrying={workflows.isFetching}
          onRetry={() => void workflows.refetch()}
        />
      ) : null}
      {list.shown === 'empty' ? (
        <WorkflowListEmpty
          canCreate={canCreate}
          starters={list.starters}
          onStart={openCreate}
        />
      ) : null}
      {list.shown === 'results' ? (
        <WorkflowListResults
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          workflows={workflows}
          items={list.items}
          search={search}
          query={query}
          filterRef={filterRef}
          onQueryChange={setQuery}
          onSearchChange={onSearchChange}
          actions={{
            onRename: setRenaming,
            onLifecycle: (workflow) => {
              setLifecycle({ workflow, intent: lifecycleIntentFor(workflow) });
            },
            onRun: (workflow) => void runner.run(workflow),
            runningId: runner.pendingId,
          }}
        />
      ) : null}
      {canCreate ? (
        <NewWorkflowSheet
          apiClient={apiClient}
          userId={user.id}
          workspaceId={workspace.id}
          open={search.create === true}
          starters={list.starters}
          choice={startChoice}
          writer={starterDraftWriter}
          onChoiceChange={setStartChoice}
          onOpenChange={(open) => {
            onSearchChange(updateWorkflowListSearch(search, { create: open }));
          }}
          onCreated={onCreated}
        />
      ) : null}
      <WorkflowDialogs
        apiClient={apiClient}
        userId={user.id}
        workspaceId={workspace.id}
        renaming={renaming}
        lifecycle={lifecycle}
        onRenameClose={() => {
          setRenaming(undefined);
        }}
        onLifecycleClose={() => {
          setLifecycle(undefined);
        }}
      />
    </div>
  );
}
