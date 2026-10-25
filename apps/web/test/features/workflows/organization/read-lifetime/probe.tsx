import { WorkflowOrganizationFilters } from '@/features/workflows/components/organization/filters';
import { useOrganizationList } from '@/features/workflows/hooks/use-organization-list';
import { userId, workspaceId } from '../../list/fixtures';
import { apiClient, folderId, tagId, workspace } from './records';
export function Probe({
  actor = userId,
  tenant = workspaceId,
}: Readonly<{ actor?: string; tenant?: string }>) {
  const result = useOrganizationList(apiClient, actor, tenant, {});
  return (
    <>
      <button onClick={() => void result.refetch()}>
        Refresh workflow reads
      </button>
      {result.data?.pages
        .flatMap((entry) => entry.organizations)
        .map((entry) => (
          <p key={entry.workflow.id}>
            {entry.workflow.name}{' '}
            {entry.organization.isFavorite ? 'Private favorite' : ''}
          </p>
        ))}
      {result.isError ? <p>Workflow reads unavailable</p> : null}
      <WorkflowOrganizationFilters
        apiClient={apiClient}
        userId={actor}
        workspace={{ ...workspace, id: tenant }}
        search={{ folderId, tagId }}
        filterRef={null}
        onSearchChange={() => undefined}
      />
    </>
  );
}
