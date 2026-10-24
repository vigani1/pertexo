import { useNavigate, useSearch } from '@tanstack/react-router';
import { UsageTrendsPage } from '@/features/usage/public';
import { parseUsageTrendsSearch } from '@/features/usage/search.public';
import { useWorkspaceScope } from './shell/use-workspace-scope';
export function UsageTrendsRoute() {
  const scope = useWorkspaceScope();
  const search = parseUsageTrendsSearch(
    useSearch({
      from: '/w/$workspaceId/shell/settings-hub/settings/usage/trends',
    }),
  );
  const navigate = useNavigate();
  return (
    <UsageTrendsPage
      apiClient={scope.apiClient}
      user={scope.user}
      workspace={scope.workspace}
      period={search.period}
      onPeriodChange={(period) => {
        void navigate({
          to: '/w/$workspaceId/settings/usage/trends',
          params: { workspaceId: scope.workspace.id },
          search: { period },
        });
      }}
    />
  );
}
