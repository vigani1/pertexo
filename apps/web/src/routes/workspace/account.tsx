import { useRouter } from '@tanstack/react-router';
import { AccountSecurityPage } from '@/features/auth/pages/account-security';
import { AccountWorkspacesSection } from '@/features/workspaces/workspaces-views.public';
import { useWorkspaceScope } from './shell/use-workspace-scope';

export function WorkspaceAccountRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const router = useRouter();
  return (
    <AccountSecurityPage
      key={user.id}
      apiClient={apiClient}
      user={user}
      workspaces={
        <AccountWorkspacesSection
          apiClient={apiClient}
          userId={user.id}
          currentWorkspaceId={workspace.id}
        />
      }
      onProfileChanged={() => void router.invalidate()}
    />
  );
}
