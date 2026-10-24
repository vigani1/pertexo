import type { AccessibleWorkspace } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { SkeletonThread } from '@/components/ui/skeleton';
import { WorkflowRowsSkeleton } from './workflow-rows';
import { WorkflowListError } from './states';
import { WorkflowListEmpty } from './empty';
import { canEditOrganization } from '../organization/editing';
import { WorkflowOrganizedResults } from '../organization/workflow-organized-results';
import type { useWorkflowList } from '../../hooks/use-workflow-list';
import type { WorkflowListSearch } from '../../model/list-view';
import type { WorkflowRowActions } from './workflow-row-actions';
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

type WorkflowListResultsProps = Readonly<{
  scope: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspace: AccessibleWorkspace;
  }>;
  list: ReturnType<typeof useWorkflowList>;
  search: WorkflowListSearch;
  creation: Readonly<{
    canCreate: boolean;
    onboarding: boolean;
    openCreate: () => void;
    chooseExample: (id: string, name?: string) => void;
  }>;
  actions: WorkflowRowActions;
}>;
export function WorkflowListResults({
  scope,
  list,
  search,
  creation,
  actions,
}: WorkflowListResultsProps) {
  const { apiClient, userId, workspace } = scope;
  const { workflows } = list;
  const { canCreate, onboarding, openCreate, chooseExample } = creation;
  return (
    <>
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
          userId={userId}
          workspace={workspace}
          items={list.organizations}
          workflows={workflows}
          actions={actions}
        />
      ) : null}
    </>
  );
}
