import { WorkflowListResults } from '../components/list/results';
import { WorkflowListOverlays } from '../components/list/commands/overlays';
import { useRef, useState, type ComponentProps } from 'react';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
  WorkflowSummary,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import {
  NewWorkflowButton,
  WorkflowListHeader,
} from '../components/list/header';
import { Button } from '@/components/ui/button';
import { lifecycleIntentFor } from '../model/lifecycle';
import {
  isUnfilteredWorkflowList,
  updateWorkflowListSearch,
  parseWorkflowListSearch,
  type WorkflowListSearch,
  type WorkflowListSearchUpdate,
} from '../model/list-view';
import { useListShortcuts } from '../hooks/use-list-shortcuts';
import { useRunWorkflow } from '../hooks/use-run-workflow';
import { WorkflowOrganizationFilters } from '../components/organization/filters';
import type { LifecycleTarget } from '../components/list/commands/dialogs';
import { useWorkflowList } from '../hooks/use-workflow-list';
import { WorkflowFolders } from '../components/organization/folders/list';

type WorkflowListContentProps = Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  search: WorkflowListSearch;
  onSearchChange: (search: WorkflowListSearchUpdate) => void | Promise<void>;
  onCreated: (workflowId: string) => void;
  /** Opens a run started from a row. */
  onRunStarted: (runId: string) => void;
}>;

function WorkflowListContent({
  apiClient,
  user,
  workspace,
  search,
  onSearchChange,
  onCreated,
  onRunStarted,
}: WorkflowListContentProps) {
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
    if (search.create ?? false)
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
      <WorkflowListResults
        scope={scope}
        list={list}
        search={search}
        creation={{ canCreate, onboarding, openCreate, chooseExample }}
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
      <WorkflowListOverlays
        scope={{ apiClient, userId: user.id, workspace }}
        creation={{
          canCreate,
          search,
          onSearchChange,
          onCreated,
          chooseExample,
        }}
        selection={{
          renaming,
          lifecycle,
          duplicating,
          exporting,
          importing,
          example,
          exampleName,
        }}
        commands={{
          setRenaming,
          setLifecycle,
          setDuplicating,
          setExporting,
          setImporting,
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
