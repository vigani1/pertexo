import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AccessibleWorkspace,
  WorkflowOrganizationProjectionResponse,
} from '@pertexo/contracts';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { WorkflowRowMenu } from '../list/workflow-row-menu';
import type { WorkflowRowActions } from '../list/workflow-row-actions';
import type { ApiClient } from '@/lib/api/client';
import { setWorkflowFavorite } from '../../data/organization/api';
import { workflowOrganizationKeys } from '../../data/organization/queries';

/** The mutation survives the popup closing so its result has one feedback owner. */
export function WorkflowOrganizationRowMenu({
  apiClient,
  userId,
  workspace,
  workflow,
  disabled = false,
  runnable,
  actions,
  onOrganize,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowOrganizationProjectionResponse;
  disabled?: boolean;
  runnable: boolean;
  actions: WorkflowRowActions;
  onOrganize?: () => void;
}>) {
  const queryClient = useQueryClient();
  const favorite = useMutation({
    mutationFn: ({ favorite }: Readonly<{ favorite: boolean }>) =>
      setWorkflowFavorite(apiClient, {
        workspaceId: workspace.id,
        workflowId: workflow.workflow.id,
        favorite,
      }),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: workflowOrganizationKeys.scope(userId, workspace.id),
      }),
  });
  const isFavorite = favorite.isPending
    ? favorite.variables.favorite
    : workflow.organization.isFavorite;
  return (
    <span className="inline-flex items-center gap-2">
      <WorkflowRowMenu
        workspace={workspace}
        workflow={workflow.workflow}
        actions={actions}
        runnable={runnable}
        organizationActions={
          <>
            <DropdownMenuItem
              disabled={
                disabled ||
                favorite.isPending ||
                workspace.status !== 'active' ||
                !workspace.capabilities.includes('workflow:read')
              }
              onClick={() => {
                favorite.mutate({ favorite: !isFavorite });
              }}
            >
              {favoriteLabel({
                pending: favorite.isPending,
                favorite: isFavorite,
              })}
            </DropdownMenuItem>
            {onOrganize === undefined ? null : (
              <DropdownMenuItem disabled={disabled} onClick={onOrganize}>
                Organize…
              </DropdownMenuItem>
            )}
          </>
        }
      />
      {favorite.isError ? (
        <span role="alert" className="text-xs text-destructive">
          Favorite not saved
        </span>
      ) : null}
    </span>
  );
}

function favoriteLabel(
  input: Readonly<{ pending: boolean; favorite: boolean }>,
) {
  if (input.pending) return 'Saving favorite…';
  if (input.favorite) return 'Remove favorite';
  return 'Add favorite';
}
