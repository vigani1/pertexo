import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { CreateWorkflowDialog } from './create-workflow-dialog';
import { WorkflowCollection } from './components/workflow-collection';
import { workflowListErrorMessage } from './workflow-errors';
import { workflowsInfiniteQueryOptions } from './workflows.queries';

type WorkflowListPageProps = Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
}>;

export function WorkflowListPage({
  apiClient,
  user,
  workspace,
}: WorkflowListPageProps) {
  const workflows = useInfiniteQuery(
    workflowsInfiniteQueryOptions(apiClient, user.id, workspace.id),
  );
  const canCreate = workspace.capabilities.includes('workflow:create');
  const items = workflows.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <h1 className="sr-only text-3xl font-semibold tracking-tight lg:not-sr-only lg:block lg:text-4xl">
          Workflows
        </h1>
        {canCreate ? (
          <CreateWorkflowDialog
            apiClient={apiClient}
            userId={user.id}
            workspaceId={workspace.id}
          />
        ) : null}
      </div>

      <WorkflowCollection
        workflows={items}
        workspaceId={workspace.id}
        apiClient={apiClient}
        userId={user.id}
        canCreate={canCreate}
        pending={workflows.isPending}
        refreshing={workflows.isRefetching && !workflows.isFetchingNextPage}
        {...(workflows.isError && !workflows.isFetchNextPageError
          ? { errorMessage: workflowListErrorMessage(workflows.error) }
          : {})}
        retrying={workflows.isRefetching}
        hasNextPage={workflows.hasNextPage}
        loadingNextPage={workflows.isFetchingNextPage}
        nextPageError={workflows.isFetchNextPageError}
        onRetry={() => void workflows.refetch()}
        onLoadMore={() => void workflows.fetchNextPage()}
        onRetryNextPage={() => void workflows.fetchNextPage()}
      />
    </div>
  );
}
