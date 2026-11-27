import { useNavigate, useSearch } from '@tanstack/react-router';
import { UsageTrendsPage } from '@/features/usage/pages/usage-trends';
import { parseUsageSearch } from '@/features/usage/usage-routing.public';
import { useWorkspaceScope } from './shell/use-workspace-scope';
export function UsageTrendsRoute() {
  const scope = useWorkspaceScope();
  const search = parseUsageSearch(
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
