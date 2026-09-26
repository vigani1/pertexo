import { useNavigate, useSearch } from '@tanstack/react-router';
import { RunHistoryPage } from '@/features/workflow-runs/public';
import { sanitizeRunSearch } from '@/features/workflow-runs/queries.public';
import { useWorkspaceScope } from './use-workspace-scope';

export function RunHistoryRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  // The router keeps unrecognized URL keys next to validated ones.
  const search = sanitizeRunSearch(
    useSearch({ from: '/w/$workspaceId/shell/runs' }),
  );
  const navigate = useNavigate();
  return (
    <RunHistoryPage
      apiClient={apiClient}
      user={user}
      workspace={workspace}
      search={search}
      onSearchChange={(next) => {
        void navigate({
          to: '/w/$workspaceId/runs',
          params: { workspaceId: workspace.id },
          search: next,
        });
      }}
    />
  );
}
