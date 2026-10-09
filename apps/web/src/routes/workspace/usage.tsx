import { useNavigate, useSearch } from '@tanstack/react-router';
import { UsagePage } from '@/features/usage/public';
import { parseUsageSearch } from '@/features/usage/usage-search.public';
import { useWorkspaceScope } from './use-workspace-scope';

export function UsageRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const search = parseUsageSearch(
    useSearch({ from: '/w/$workspaceId/shell/settings/usage' }),
  );
  const navigate = useNavigate();
  return (
    <UsagePage
      apiClient={apiClient}
      user={user}
      workspace={workspace}
      search={search}
      onSearchChange={(next) => {
        void navigate({
          to: '/w/$workspaceId/settings/usage',
          params: { workspaceId: workspace.id },
          search: next,
        });
      }}
    />
  );
}
