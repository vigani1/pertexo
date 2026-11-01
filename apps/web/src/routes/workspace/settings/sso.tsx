import { useSearch } from '@tanstack/react-router';
import { FederationSettingsPage } from '@/features/federation/public';
import { useWorkspaceScope } from '../shell/use-workspace-scope';
export function FederationSettingsRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const search = useSearch({
    from: '/w/$workspaceId/shell/settings-hub/settings/sso',
  });
  return (
    <FederationSettingsPage
      key={`${user.id}:${workspace.id}`}
      scope={{ apiClient, userId: user.id, workspaceId: workspace.id }}
      workspace={workspace}
      testResult={search.ssoTest}
      testFailure={search.ssoReason}
      section={search.ssoSection}
    />
  );
}
