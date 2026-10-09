import { useRouter } from '@tanstack/react-router';
import { AccountSecurityPage } from '@/features/auth/account-security.public';
import { AccountWorkspacesSection } from '@/features/workspaces/account-workspaces.public';
import { useWorkspaceScope } from './use-workspace-scope';

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
