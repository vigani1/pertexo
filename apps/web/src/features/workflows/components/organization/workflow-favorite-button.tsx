import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AccessibleWorkspace,
  WorkflowOrganizationProjectionResponse,
} from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { setWorkflowFavorite } from '../../data/organization.api';
import { workflowOrganizationKeys } from '../../data/organization.queries';

/** Marks or unmarks a workflow as one of the user's favorites. */
export function WorkflowFavoriteButton({
  apiClient,
  userId,
  workspace,
  workflow,
  disabled = false,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowOrganizationProjectionResponse;
  disabled?: boolean;
}>) {
  const queryClient = useQueryClient();
  const favorite = useMutation({
    mutationFn: (value: boolean) =>
      setWorkflowFavorite(apiClient, {
        workspaceId: workspace.id,
        workflowId: workflow.workflow.id,
        favorite: value,
      }),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: workflowOrganizationKeys.scope(userId, workspace.id),
      }),
  });
  const isFavorite = favorite.isPending
    ? favorite.variables
    : workflow.organization.isFavorite;
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        aria-label={`${isFavorite ? 'Remove' : 'Add'} favorite for ${workflow.workflow.name}`}
        aria-pressed={isFavorite}
        disabled={
          disabled ||
          favorite.isPending ||
          workspace.status !== 'active' ||
          !workspace.capabilities.includes('workflow:read')
        }
        onClick={() => {
          favorite.mutate(!isFavorite);
        }}
      >
        {isFavorite ? 'Remove favorite' : 'Add favorite'}
      </Button>
      {favorite.isError ? (
        <span role="alert" className="text-xs text-destructive">
          Favorite not saved
        </span>
      ) : null}
    </span>
  );
}
