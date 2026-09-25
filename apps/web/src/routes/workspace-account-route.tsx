import { useRouter } from '@tanstack/react-router';
import { AccountSecurityPage } from '@/features/auth/account-security.public';
import { useWorkspaceScope } from './use-workspace-scope';

export function WorkspaceAccountRoute() {
  const { apiClient, user } = useWorkspaceScope();
  const router = useRouter();
  return (
    <AccountSecurityPage
      key={user.id}
      apiClient={apiClient}
      user={user}
      onProfileChanged={() => void router.invalidate()}
    />
  );
}
