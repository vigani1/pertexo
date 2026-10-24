import { isAdministrativeRole } from '@pertexo/workflow-model';
import { useCallback, useRef, useState, type ComponentProps } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
  WorkflowSummary,
} from '@pertexo/contracts';
import { SkeletonThread } from '@/components/ui/skeleton';
import type { ApiClient } from '@/lib/api/client';
import { NewWorkflowSheet } from '../components/creation/new-workflow-sheet';
import { WorkflowLifecycleDialog } from '../components/workflow-lifecycle-dialog';
import {
  NewWorkflowButton,
  WorkflowListHeader,
} from '../components/list/header';
import { WorkflowListEmpty } from '../components/list/empty';
import { WorkflowListError } from '../components/list/states';
import { WorkflowRenameDialog } from '../components/workflow-rename-dialog';
import { WorkflowDuplicateDialog } from '../components/workflow-duplicate-dialog';
import { WorkflowExportDialog } from '../components/portability/workflow-export-dialog';
import { WorkflowImportDialog } from '../components/portability/workflow-import-dialog';
import { Button } from '@/components/ui/button';
import { WorkflowRowsSkeleton } from '../components/list/workflow-rows';
import { canEditOrganization } from '../components/organization/editing';
import { lifecycleIntentFor, type LifecycleIntent } from '../model/lifecycle';
import {
  isUnfilteredWorkflowList,
  updateWorkflowListSearch,
  parseWorkflowListSearch,
  type WorkflowListSearch,
  type WorkflowListSearchUpdate,
} from '../model/list-view';
import { useListShortcuts } from '../hooks/use-list-shortcuts';
import { useRunWorkflow } from '../hooks/use-run-workflow';
import { useOrganizationList } from '../hooks/use-organization-list';
import { WorkflowOrganizationFilters } from '../components/organization/filters';
import { WorkflowOrganizedResults } from '../components/organization/workflow-organized-results';
import {
  FolderShelf,
  type FolderAction,
} from '../components/organization/folders/shelf';
import { FolderActionDialog } from '../components/organization/folders/actions';
import { workflowFoldersQueryOptions } from '../data/organization/queries';
import {
  isOrganizationReadDenied,
  useOrganizationReadLifetime,
} from '../hooks/use-organization-read-lifetime';

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
function listState({
  pending,
  loaded,
  empty,
}: Readonly<{ pending: boolean; loaded: boolean; empty: boolean }>):
  'loading' | 'failed' | 'empty' | 'results' {
  if (pending) return 'loading';
  if (!loaded) return 'failed';
  return empty ? 'empty' : 'results';
}

type ListScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
}>;

/**
 * The list's pages in the chosen order and which of the list's states is on
 * screen. Changing the sort keeps the current rows until the re-sorted pages
 * land.
 */
function useWorkflowList(
  { apiClient, userId, workspace }: ListScope,
  search: WorkflowListSearch,
) {
  const workflows = useOrganizationList(
    apiClient,
    userId,
    workspace.id,
    search,
  );
  const items = workflows.data?.pages.flatMap((page) => page.items) ?? [];
  const empty = workflows.data !== undefined && items.length === 0;
  return {
    workflows,
    items,
    empty,
    shown: listState({
      pending: workflows.isPending,
      loaded: workflows.data !== undefined,
      empty,
    }),
    organizations:
      workflows.data?.pages.flatMap((page) => page.organizations) ?? [],
  } as const;
}

/**
 * The folders above the list and the dialog for whichever folder action is
 * open. Folders are managed by owners and admins; everyone can open them.
 */
function WorkflowFolders({
  apiClient,
  userId,
  workspace,
  folderId,
  onOpen,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  folderId: string | undefined;
  onOpen: (folderId: string | null) => void;
}>) {
  // A denied organization read anywhere retires the folder names too.
  const lifetime = useOrganizationReadLifetime(userId, workspace.id);
  const folders = useQuery({
    ...workflowFoldersQueryOptions(apiClient, userId, workspace.id),
    enabled: lifetime.error === undefined,
  });
  const [action, setAction] = useState<FolderAction>();
  const items = folders.data?.items ?? [];
  const canManage =
    workspace.status === 'active' && isAdministrativeRole(workspace.role);
  const close = useCallback(() => {
    setAction(undefined);
  }, []);
  const done = useCallback(
    (finished: FolderAction) => {
      setAction(undefined);
      // Leaving a folder that no longer exists.
      if (finished.kind === 'delete' && finished.folder.id === folderId)
        onOpen(finished.folder.parentId);
    },
    [folderId, onOpen],
  );
  if (
    folders.data === undefined ||
    lifetime.error !== undefined ||
    isOrganizationReadDenied(folders.error)
  )
    return null;
  return (
    <>
      <FolderShelf
        folders={items}
        currentFolderId={folderId === 'root' ? undefined : folderId}
        canManage={canManage}
        onOpen={onOpen}
        onAction={setAction}
      />
      {action === undefined ? null : (
        <FolderActionDialog
          key={`${action.kind}:${action.kind === 'create' ? (action.parent?.id ?? 'top') : action.folder.id}`}
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          folders={items}
          action={action}
          onClose={close}
          onDone={done}
        />
      )}
    </>
  );
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
  onSearchChange,
  onCreated,
  onRunStarted,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  search: WorkflowListSearch;
  onSearchChange: (search: WorkflowListSearchUpdate) => void | Promise<void>;
  onCreated: (workflowId: string) => void;
  /** Opens a run started from a row. */
  onRunStarted: (runId: string) => void;
}>) {
  const canCreate = workspace.capabilities.includes('workflow:create');
  const scope = { apiClient, userId: user.id, workspace };
  const list = useWorkflowList(scope, search);
  const { workflows } = list;
  // An empty workspace with no filter shows the first-workflow onboarding.
  const onboarding = list.shown === 'empty' && isUnfilteredWorkflowList(search);
  const filterRef = useRef<HTMLInputElement>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleTarget>();
  const [renaming, setRenaming] = useState<WorkflowSummary>();
  const [duplicating, setDuplicating] = useState<WorkflowSummary>();
  const [exporting, setExporting] = useState<WorkflowSummary>();
  const [importing, setImporting] = useState(false);
  // The example a start-from-example dialog opened on; none imports a file.
  const [example, setExample] = useState<string>();
  const [exampleName, setExampleName] = useState('');
  const runner = useRunWorkflow({
    apiClient,
    userId: user.id,
    workspaceId: workspace.id,
    onRunStarted,
  });

  function openCreate() {
    void onSearchChange(updateWorkflowListSearch(search, { create: true }));
  }

  function openImport(nextExample?: string, name = '') {
    setExampleName(name);
    setExample(nextExample);
    setImporting(true);
  }

  function chooseExample(templateId: string, name = '') {
    if (search.create === true)
      void onSearchChange(updateWorkflowListSearch(search, { create: false }));
    openImport(templateId, name);
  }

  useListShortcuts({
    onFocusFilter: () => {
      filterRef.current?.focus();
    },
    onCreate: canCreate ? openCreate : undefined,
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
                  openImport();
                }}
              >
                Import workflow…
              </Button>
              {onboarding ? null : <NewWorkflowButton onClick={openCreate} />}
            </div>
          ) : undefined
        }
      />
      <WorkflowFolders
        apiClient={apiClient}
        userId={user.id}
        workspace={workspace}
        folderId={search.folderId}
        onOpen={(folderId) => {
          void onSearchChange((current) =>
            updateWorkflowListSearch(current, { folderId }),
          );
        }}
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
      {list.shown === 'loading' ? (
        <WorkflowRowsSkeleton
          selectable={canEditOrganization(workspace, [], 'move')}
        />
      ) : null}
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
          onStartBlank={openCreate}
          onChooseExample={chooseExample}
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
          onOpenChange={(open) => {
            void onSearchChange(
              updateWorkflowListSearch(search, { create: open }),
            );
          }}
          onCreated={onCreated}
          onChooseExample={chooseExample}
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
      {/* A file import and each example keep their own session, so a
          retained file import isn't mixed with an example's setup. */}
      <WorkflowImportDialog
        key={`${user.id}:${workspace.id}:${example ?? 'file'}:${exampleName}`}
        apiClient={apiClient}
        userId={user.id}
        workspace={workspace}
        open={importing}
        example={example}
        initialName={exampleName}
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
