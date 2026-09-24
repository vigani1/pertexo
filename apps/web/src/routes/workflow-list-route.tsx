import { useNavigate, useSearch } from '@tanstack/react-router';
import { WorkflowListPage } from '@/features/workflows/list.public';
import { useWorkspaceScope } from './use-workspace-scope';

export function WorkflowListRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const search = useSearch({ from: '/w/$workspaceId/shell/workflows' });
  const navigate = useNavigate();
  // Starters need the editor's draft-save transport, which has no public
  // interface yet; until it does, the New workflow lens offers Blank only.
  return (
    <WorkflowListPage
      apiClient={apiClient}
      user={user}
      workspace={workspace}
      search={search}
      onSearchChange={(next) => {
        void navigate({
          to: '/w/$workspaceId/workflows',
          params: { workspaceId: workspace.id },
          search: next,
          // Opening the lens is a step Back can undo; filters just replace.
          replace: next.create !== true || search.create === true,
        });
      }}
      onCreated={(workflowId) => {
        void navigate({
          to: '/w/$workspaceId/workflows/$workflowId',
          params: { workspaceId: workspace.id, workflowId },
        });
      }}
    />
  );
}
