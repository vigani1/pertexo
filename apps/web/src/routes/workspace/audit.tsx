import { useNavigate, useSearch } from '@tanstack/react-router';
import { AuditPage } from '@/features/governance/public';
import { useWorkspaceScope } from './shell/use-workspace-scope';
export function AuditRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const filters = useSearch({
    from: '/w/$workspaceId/shell/settings-hub/settings/audit',
  });
  const navigate = useNavigate();
  return (
    <AuditPage
      key={`${user.id}:${workspace.id}`}
      scope={{ apiClient, userId: user.id, workspaceId: workspace.id }}
      workspace={workspace}
      filters={filters}
      onFilter={(search) => {
        void navigate({
          to: '/w/$workspaceId/settings/audit',
          params: { workspaceId: workspace.id },
          search,
        });
      }}
    />
  );
}
