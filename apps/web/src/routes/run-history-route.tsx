import { useNavigate, useSearch } from '@tanstack/react-router';
import { RunHistoryPage } from '@/features/workflow-runs/public';
import { useWorkspaceScope } from './use-workspace-scope';

export function RunHistoryRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const filters = useSearch({ from: '/w/$workspaceId/shell/runs' });
  const navigate = useNavigate();
  return (
    <RunHistoryPage
      apiClient={apiClient}
      user={user}
      workspace={workspace}
      filters={filters}
      onFiltersChange={(search) => {
        void navigate({
          to: '/w/$workspaceId/runs',
          params: { workspaceId: workspace.id },
          search,
        });
      }}
    />
  );
}
