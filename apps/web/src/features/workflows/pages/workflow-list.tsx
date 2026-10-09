import { useRef, useState, type ComponentProps } from 'react';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
  WorkflowSummary,
} from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { SkeletonThread } from '@/components/ui/skeleton';
import { authoringCatalogQueryOptions } from '@/features/catalog/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { NewWorkflowSheet } from '../components/creation/new-workflow-sheet';
import type { StartChoice } from '../components/creation/starter-choice';
import { WorkflowLifecycleDialog } from '../components/workflow-lifecycle-dialog';
import {
  NewWorkflowButton,
  WorkflowListHeader,
} from '../components/list/workflow-list-header';
import { WorkflowListEmpty } from '../components/list/workflow-list-empty';
import { WorkflowListError } from '../components/list/workflow-list-states';
import { WorkflowRenameDialog } from '../components/workflow-rename-dialog';
import { WorkflowDuplicateDialog } from '../components/workflow-duplicate-dialog';
import { WorkflowExportDialog } from '../components/portability/workflow-export-dialog';
import { WorkflowImportDialog } from '../components/portability/workflow-import-dialog';
import { Button } from '@/components/ui/button';
import { WorkflowRowsSkeleton } from '../components/list/workflow-rows';
import { lifecycleIntentFor, type LifecycleIntent } from '../model/lifecycle';
import {
  isUnfilteredWorkflowList,
  updateWorkflowListSearch,
  parseWorkflowListSearch,
  type WorkflowListSearch,
  type WorkflowListSearchUpdate,
} from '../model/list-view';
import { availableStarters } from '../model/templates/starters';
import { useListShortcuts } from '../hooks/use-list-shortcuts';
import { useRunWorkflow } from '../hooks/use-run-workflow';
import type { StarterDraftWriter } from '../data/workflows.mutations';
import { useOrganizationList } from '../hooks/use-organization-list';
import { WorkflowOrganizationFilters } from '../components/organization/workflow-organization-filters';
import { WorkflowOrganizedResults } from '../components/organization/workflow-organized-results';

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
  search: WorkflowListSearch,
  starterDraftWriter: StarterDraftWriter | undefined,
) {
  const canCreate = workspace.capabilities.includes('workflow:create');
  const workflows = useOrganizationList(
    apiClient,
    userId,
    workspace.id,
    search,
  );
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
    organizations:
      workflows.data?.pages.flatMap((page) => page.organizations) ?? [],
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

function WorkflowListContent({
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
  onSearchChange: (search: WorkflowListSearchUpdate) => void;
  onCreated: (workflowId: string) => void;
  /** Opens a run started from a row. */
  onRunStarted: (runId: string) => void;
}>) {
  const canCreate = workspace.capabilities.includes('workflow:create');
  const scope = { apiClient, userId: user.id, workspace };
  const list = useWorkflowList(scope, search, starterDraftWriter);
  const { workflows } = list;
  // An empty workspace with no filter shows the first-workflow onboarding.
  const onboarding = list.shown === 'empty' && isUnfilteredWorkflowList(search);
  const filterRef = useRef<HTMLInputElement>(null);
  const [startChoice, setStartChoice] = useState<StartChoice>('blank');
  const [lifecycle, setLifecycle] = useState<LifecycleTarget>();
  const [renaming, setRenaming] = useState<WorkflowSummary>();
  const [duplicating, setDuplicating] = useState<WorkflowSummary>();
  const [exporting, setExporting] = useState<WorkflowSummary>();
  const [importing, setImporting] = useState(false);
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
          canCreate ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setImporting(true);
                }}
              >
                Import workflow…
              </Button>
              {onboarding ? null : (
                <NewWorkflowButton
                  onClick={() => {
                    openCreate('blank');
                  }}
                />
              )}
            </div>
          ) : undefined
        }
      />
      <WorkflowOrganizationFilters
        apiClient={apiClient}
        userId={user.id}
        workspace={workspace}
        search={search}
        filterRef={filterRef}
        onSearchChange={onSearchChange}
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
      {onboarding ? (
        <WorkflowListEmpty
          canCreate={canCreate}
          starters={list.starters}
          onStart={openCreate}
        />
      ) : null}
      {list.shown === 'results' || (list.shown === 'empty' && !onboarding) ? (
        <WorkflowOrganizedResults
          key={JSON.stringify(search)}
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          items={list.organizations}
          workflows={workflows}
          actions={{
            onRename: setRenaming,
            onDuplicate: setDuplicating,
            onExport: setExporting,
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
          onChooseTemplate={() => {
            onSearchChange(updateWorkflowListSearch(search, { create: false }));
            setImporting(true);
          }}
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
      {duplicating === undefined ? null : (
        <WorkflowDuplicateDialog
          key={`${user.id}:${workspace.id}:${duplicating.id}`}
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          workflow={duplicating}
          source={{ kind: 'draft' }}
          onClose={() => {
            setDuplicating(undefined);
          }}
          onCreated={(workflowId) => {
            setDuplicating(undefined);
            onCreated(workflowId);
          }}
        />
      )}
      {exporting === undefined ? null : (
        <WorkflowExportDialog
          key={`${user.id}:${workspace.id}:${exporting.id}`}
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          workflow={exporting}
          source={{ kind: 'draft' }}
          onClose={() => {
            setExporting(undefined);
          }}
        />
      )}
      <WorkflowImportDialog
        key={`${user.id}:${workspace.id}`}
        apiClient={apiClient}
        userId={user.id}
        workspace={workspace}
        open={importing}
        onReopen={() => {
          setImporting(true);
        }}
        onClose={() => {
          setImporting(false);
        }}
        onCreated={(id) => {
          setImporting(false);
          onCreated(id);
        }}
      />
    </div>
  );
}

/** Changing actor, workspace or role retires every private dialog/attempt. */
export function WorkflowListPage(
  props: ComponentProps<typeof WorkflowListContent>,
) {
  return (
    <WorkflowListContent
      key={`${props.user.id}:${props.workspace.id}:${props.workspace.role}:${props.workspace.status}`}
      {...props}
      search={parseWorkflowListSearch(props.search)}
    />
  );
}
